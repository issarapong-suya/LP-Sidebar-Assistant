'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const db = require('./db');
const audit = require('./audit-log');

const app = express();
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PRODUCT_VERSION = '1';
const PRODUCT_BUILD = '20261109.01';
const companionSessions = new Map();
const manualSessions = new Map();
const enrollmentCodes = new Map();
const enrollmentAttempts = new Map();
const ENROLLMENT_TTL_MS = 30 * 60 * 1000;
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.set('X-Request-ID', req.requestId);
  next();
});
// Avoid writing query strings, which can contain patient identifiers, to routine access logs.
app.use(morgan((tokens, req, res) => `${tokens.method(req, res)} ${tokens.status(req, res)} ${tokens['response-time'](req, res)} ms`));
app.use(express.json({ limit: '64kb' }));

function cleanIp(value) {
  let ip = String(value || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip === '::1' ? '127.0.0.1' : ip;
}

function isLocal(req) {
  const ip = cleanIp(req.socket?.remoteAddress || req.ip);
  return ip === '127.0.0.1' || ip === 'localhost';
}

function requestClientIp(req) {
  const socketIp = cleanIp(req.socket?.remoteAddress || req.ip);
  if ((socketIp === '127.0.0.1' || socketIp === 'localhost') && req.get('x-forwarded-for')) {
    const forwarded = String(req.get('x-forwarded-for')).split(',').map(value => value.trim()).filter(Boolean);
    if (forwarded.length) return cleanIp(forwarded[forwarded.length - 1]);
  }
  return socketIp;
}

function requestIsSecure(req) {
  if (req.secure) return true;
  const proxyIp = cleanIp(req.socket?.remoteAddress || req.ip);
  return (proxyIp === '127.0.0.1' || proxyIp === 'localhost')
    && String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase() === 'https';
}

function getManualSession(req, touch = false) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('doctor_session='));
  const token = cookie ? cookie.slice('doctor_session='.length) : '';
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const session = manualSessions.get(token);
  if (!session) return null;
  const now = Date.now();
  if (now - session.createdAt > 8 * 60 * 60 * 1000 || now - session.lastActivity > 30 * 60 * 1000) {
    manualSessions.delete(token);
    return null;
  }
  if (touch) session.lastActivity = now;
  return session;
}

function setSessionCookie(res, token, req, maxAge = 8 * 60 * 60) {
  const secure = requestIsSecure(req) ? '; Secure' : '';
  res.set('Set-Cookie', `doctor_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function clearManualSession(req, res) {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('doctor_session='));
  if (!cookie) return null;
  const session = getManualSession(req, false);
  const token = cookie.slice('doctor_session='.length);
  if (/^[a-f0-9]{64}$/.test(token)) manualSessions.delete(token);
  if (res) setSessionCookie(res, '', req, 0);
  return session;
}

function isAllowed(req, config) {
  const ip = requestClientIp(req);
  const security = config?.security || {};
  const rules = Array.isArray(security.allowedLanSubnets) ? security.allowedLanSubnets : [];
  if (rules.some(rule => rule && (rule.endsWith('.') ? ip.startsWith(rule) : ip === rule))) return true;
  const key = security.apiKey;
  return Boolean(key && req.get('x-api-key') === key);
}

function localSetupOnly(req, res, next) {
  if (isLocal(req) && !req.get('x-forwarded-for')) return next();
  const config = db.getConfig();
  if (config?.security?.allowRemoteSetup === true && isAllowed(req, config)) {
    return next();
  }
  if (process.env.ALLOW_REMOTE_SETUP === 'true' && (!config || isAllowed(req, config))) {
    return next();
  }
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.status(403).send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>Setup Restricted</title>
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;}
      .card{max-width:520px;background:#fff;padding:32px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,0.08);text-align:center;}
      h2{color:#0f2738;margin-top:0;}p{color:#64748b;line-height:1.6;font-size:14.5px;}code{background:#f1f5f9;padding:4px 8px;border-radius:6px;color:#0f766e;}
      </style></head><body><div class="card">
      <h2>🔒 จำกัดการเข้าถึงหน้า Setup</h2>
      <p>ตามค่าความปลอดภัยเริ่มต้น หน้า Setup อนุญาตให้เปิดจากเครื่อง Server เท่านั้น (<code>http://localhost:3030/setup</code>)</p>
      <p>หากแอดมินต้องการเปิดจากเครื่องทำงานในวง LAN ให้เปิดตัวเลือก <b>"อนุญาตให้เข้าหน้า Setup จากเครื่องแอดมินในวง LAN"</b> ในหน้าตั้งค่า หรือใส่ <code>"allowRemoteSetup": true</code> ใน <code>config.json</code> ของเซิร์ฟเวอร์</p>
      </div></body></html>
    `);
  }
  return res.status(403).json({ success: false, error: 'หน้านี้เปิดได้จากเครื่อง Server เท่านั้น (ใช้ http://localhost:<port>/setup) หรือเปิด allowRemoteSetup ในไฟล์ตั้งค่า' });
}

function persistConfig(config) {
  const tempPath = `${db.CONFIG_PATH}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, db.CONFIG_PATH);
}

function enrollmentHash(code) {
  return crypto.createHash('sha256').update(String(code || '').trim().toLowerCase()).digest('hex');
}

function createInstallTicket(ip) {
  const now = Date.now();
  for (const [hash, entry] of enrollmentCodes) {
    if (entry.expiresAt <= now || entry.used || entry.ip === ip) enrollmentCodes.delete(hash);
  }
  const ticket = crypto.randomBytes(16).toString('hex');
  enrollmentCodes.set(enrollmentHash(ticket), { expiresAt: now + ENROLLMENT_TTL_MS, used: false, ip });
  return { ticket, expiresAt: new Date(now + ENROLLMENT_TTL_MS).toISOString() };
}

function secureForEnrollment(req) {
  const config = db.getConfig();
  if (config?.security?.allowInsecureEnrollment !== false) return true;
  return requestIsSecure(req);
}

function getLatestCompanionRelease() {
  const distDir = path.join(ROOT, '..', 'companion', 'dist');
  if (!fs.existsSync(distDir)) return null;
  const files = fs.readdirSync(distDir)
    .filter(f => /^DoctorAssistantCompanion.*\.exe$/i.test(f))
    .map(f => {
      const fullPath = path.join(distDir, f);
      return { name: f, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    });
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0];
}

function companionDeviceRecords(config = db.getConfig()) {
  return Array.isArray(config?.security?.companionDevices) ? config.security.companionDevices : [];
}

app.get('/health', (req, res) => res.json({ status: 'ok', configured: !!db.getConfig(), productVersion: PRODUCT_VERSION, build: PRODUCT_BUILD, time: new Date().toISOString() }));
app.get('/api/version', (req, res) => res.json({ product: 'Sidebar Doctor Assistant', version: PRODUCT_VERSION, build: PRODUCT_BUILD }));

app.get('/api/setup/auto-detect-labs', localSetupOnly, async (req, res) => {
  try {
    const pool = db.getPool();
    const [items] = await pool.execute('SELECT lab_items_code, lab_items_name, lab_items_unit, lab_items_normal_value FROM lab_items WHERE lab_items_name IS NOT NULL AND lab_items_name != ""');
    
    const detected = {
      creatinine: [],
      potassium: [],
      sodium: [],
      bun: [],
      ast: [],
      alt: [],
      uric: [],
      ldl: [],
      hct: [],
      platelet: [],
      uacr: []
    };

    const details = {
      creatinine: [],
      potassium: [],
      sodium: [],
      bun: [],
      ast: [],
      alt: [],
      uric: [],
      ldl: [],
      hct: [],
      platelet: [],
      uacr: []
    };

    items.forEach(item => {
      const code = String(item.lab_items_code).trim();
      const name = String(item.lab_items_name || '').trim();
      const nameLower = name.toLowerCase();

      if (/ยกเลิก|ไม่ใช้|delete/i.test(name)) return;

      if (/^creatinine$/i.test(name) || /^serum\s*creatinine$/i.test(name) || /^creatinine\s*\(cr\)$/i.test(name)) {
        if (!/clearance|urine|fluid|ratio/i.test(nameLower)) {
          detected.creatinine.push(code);
          details.creatinine.push({ code, name });
        }
      }

      if (/^potassium(\s*\(k\))?$/i.test(name) || /^k\s*(\(potassium\))?$/i.test(name) || /^serum\s*potassium$/i.test(name)) {
        if (!/urine|fluid/i.test(nameLower)) {
          detected.potassium.push(code);
          details.potassium.push({ code, name });
        }
      }

      if (/^sodium(\s*\(na\))?$/i.test(name) || /^na\s*(\(sodium\))?$/i.test(name) || /^serum\s*sodium$/i.test(name)) {
        if (!/urine|fluid/i.test(nameLower)) {
          detected.sodium.push(code);
          details.sodium.push({ code, name });
        }
      }

      if (/^bun$/i.test(name) || /^blood\s*urea\s*nitrogen$/i.test(name)) {
        if (!/fluid/i.test(nameLower)) {
          detected.bun.push(code);
          details.bun.push({ code, name });
        }
      }

      if (/^sgot(\s*\(ast\))?$/i.test(name) || /^ast(\s*\(sgot\))?$/i.test(name)) {
        detected.ast.push(code);
        details.ast.push({ code, name });
      }

      if (/^sgpt(\s*\(alt\))?$/i.test(name) || /^alt(\s*\(sgpt\))?$/i.test(name)) {
        detected.alt.push(code);
        details.alt.push({ code, name });
      }

      if (/^(serum\s*)?uric(\s*acid)?$/i.test(name)) {
        if (!/crystal|fluid|urine/i.test(nameLower)) {
          detected.uric.push(code);
          details.uric.push({ code, name });
        }
      }

      if (/^ldl(-c)?(\s*cholesterol)?$/i.test(name) || /direct\s*ldl/i.test(name) || /^ldl\s*-\s*chol/i.test(name)) {
        detected.ldl.push(code);
        details.ldl.push({ code, name });
      }

      if (/^hct\d*$/i.test(name) || /^h[ae]?matocrit\d*$/i.test(name)) {
        if (!/gas/i.test(nameLower)) {
          detected.hct.push(code);
          details.hct.push({ code, name });
        }
      }

      if (/^platelet\s*count$/i.test(name) || /^plt\s*count$/i.test(name) || /^platelet$/i.test(name)) {
        if (!/smear|conc|single\s*donor|rich/i.test(nameLower)) {
          detected.platelet.push(code);
          details.platelet.push({ code, name });
        }
      }

      if (/^uacr$/i.test(name) || /urine\s*microalbumin/i.test(name) || /^microalbumin$/i.test(name) || /albumin.*creatinine\s*ratio/i.test(name)) {
        detected.uacr.push(code);
        details.uacr.push({ code, name });
      }
    });

    res.json({ success: true, detected, details });
  } catch (error) {
    console.error('[setup] auto-detect-labs error:', error);
    res.status(500).json({ success: false, error: 'ไม่สามารถตรวจจับรหัสแล็ปได้: ' + (error.message || error) });
  }
});

app.get('/api/setup/status', localSetupOnly, (req, res) => {
  const config = db.getConfig();
  res.json({ configured: !!config, config: config ? {
    port: config.port,
    hospitalName: config.hospitalName || '',
    hospitalCode: config.hospitalCode || '',
    hosxp: { host: config.hosxp?.host || '', port: config.hosxp?.port || 3306, database: config.hosxp?.database || '', user: config.hosxp?.user || '' },
    security: {
      allowedLanSubnets: config.security?.allowedLanSubnets || ['127.0.0.1', '::1'],
      allowInsecureEnrollment: config.security?.allowInsecureEnrollment !== false,
      allowRemoteSetup: config.security?.allowRemoteSetup === true
    },
    schema: {
      creatinineLabCode: config.schema?.creatinineLabCode || '155',
      searchCharset: config.schema?.searchCharset || 'tis620',
      labTrendCodes: config.schema?.labTrendCodes || {}
    }
  } : null });
});

app.get('/api/setup/companion/devices', localSetupOnly, (req, res) => {
  const sessions = Array.from(companionSessions.values());
  const now = Date.now();
  const registered = companionDeviceRecords().map(device => {
    const active = !device.revokedAt ? sessions.find(s => (s.deviceId === device.id || s.computer === device.name) && s.active && (now - s.timestamp <= 25000)) : null;
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      revokedAt: device.revokedAt || null,
      isOnline: Boolean(active),
      currentUser: active ? (active.user || '') : '',
      clientIp: active?.clientIp || device.clientIp || '',
      localIp: active?.localIp || device.localIp || ''
    };
  });

  // Include any actively connected companion session not yet in the registered list
  for (const session of sessions) {
    if (session.active && (now - session.timestamp <= 25000)) {
      const already = registered.some(d => !d.revokedAt && (d.id === session.deviceId || d.name === session.computer));
      if (!already) {
        registered.unshift({
          id: session.deviceId || `session-${session.clientIp || 'device'}`,
          name: session.computer || `Workstation ${session.localIp || session.clientIp}`,
          createdAt: new Date(session.timestamp).toISOString(),
          revokedAt: null,
          isOnline: true,
          currentUser: session.user || '',
          clientIp: session.clientIp || '',
          localIp: session.localIp || '',
          isLegacy: !session.deviceId || session.deviceId === 'legacy'
        });
      }
    }
  }

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ success: true, devices: registered });
});

app.post('/api/setup/companion/devices/:id/delete', localSetupOnly, (req, res) => {
  try {
    const config = db.getConfig();
    if (config?.security?.companionDevices) {
      const initial = config.security.companionDevices.length;
      config.security.companionDevices = config.security.companionDevices.filter(d => d.id !== req.params.id);
      if (config.security.companionDevices.length !== initial) {
        persistConfig(config);
        audit.record({ requestId: req.requestId, action: 'COMPANION_DEVICE_DELETED', actor: 'local-setup', outcome: 'success' });
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'ลบรายการอุปกรณ์ไม่สำเร็จ' });
  }
});

app.post('/api/install/ticket', (req, res) => {
  const config = db.getConfig();
  if (!config) return res.status(503).json({ success: false, error: 'Server ยังไม่ได้ตั้งค่า' });
  if (!isAllowed(req, config)) return res.status(403).json({ success: false, error: 'เครือข่ายนี้ไม่ได้รับอนุญาต' });
  if (!isLocal(req) && !secureForEnrollment(req)) return res.status(426).json({ success: false, error: 'การติดตั้งจากเครื่องอื่นต้องเปิดผ่าน HTTPS' });
  const { ticket, expiresAt } = createInstallTicket(requestClientIp(req));
  audit.record({ requestId: req.requestId, action: 'COMPANION_INSTALL_TICKET_ISSUED', outcome: 'success' });
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ success: true, ticket, expiresAt });
});

app.get('/api/install/status', (req, res) => {
  const config = db.getConfig();
  if (!config) return res.status(503).json({ success: false, error: 'Server ยังไม่ได้ตั้งค่า' });
  const ip = requestClientIp(req);
  const session = companionSessions.get(ip);
  const isConnected = Boolean(session?.active && (Date.now() - session.timestamp <= 25000));
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({
    success: true,
    ip,
    connected: isConnected,
    workstation: isConnected ? (session.computer || '') : '',
    user: isConnected ? (session.user || '') : '',
    timestamp: Date.now()
  });
});

app.post('/api/setup/companion/devices/:id/revoke', localSetupOnly, (req, res) => {
  try {
    const config = db.getConfig();
    const device = companionDeviceRecords(config).find(item => item.id === req.params.id);
    if (!device) return res.status(404).json({ success: false, error: 'ไม่พบอุปกรณ์นี้' });
    if (!device.revokedAt) {
      device.revokedAt = new Date().toISOString();
      persistConfig(config);
      const sessions = req.app.get('companionSessions');
      for (const [ip, session] of sessions) if (session.deviceId === device.id) sessions.delete(ip);
      audit.record({ requestId: req.requestId, action: 'COMPANION_DEVICE_REVOKED', actor: 'local-setup', workstation: device.name, outcome: 'success' });
    }
    res.json({ success: true, devices: companionDeviceRecords(config).map(item => ({ id: item.id, name: item.name, createdAt: item.createdAt, revokedAt: item.revokedAt || null })) });
  } catch (error) {
    res.status(500).json({ success: false, error: 'เพิกถอนอุปกรณ์ไม่สำเร็จ ตรวจสอบไฟล์ตั้งค่าระบบ' });
  }
});

app.post('/api/install/enroll', (req, res) => {
  const config = db.getConfig();
  if (!config) return res.status(503).json({ success: false, error: 'Server ยังไม่ได้ตั้งค่า' });
  if (!isAllowed(req, config)) return res.status(403).json({ success: false, error: 'เครือข่ายนี้ไม่ได้รับอนุญาต' });
  const ip = requestClientIp(req);
  if (!isLocal(req) && !secureForEnrollment(req)) return res.status(426).json({ success: false, error: 'การลงทะเบียนจากเครื่องอื่นต้องใช้ HTTPS เพื่อปกป้อง token' });
  const now = Date.now();
  const attempts = enrollmentAttempts.get(ip) || { count: 0, resetAt: now + 10 * 60 * 1000 };
  if (attempts.resetAt <= now) { attempts.count = 0; attempts.resetAt = now + 10 * 60 * 1000; }
  if (attempts.count >= 8) return res.status(429).json({ success: false, error: 'ลองลงทะเบียนหลายครั้งเกินไป กรุณารอ 10 นาที' });
  const ticket = String(req.body?.ticket || '').trim().toLowerCase();
  const ticketHash = enrollmentHash(ticket);
  const ticketEntry = enrollmentCodes.get(ticketHash);
  if (!/^[a-f0-9]{32}$/.test(ticket) || !ticketEntry || ticketEntry.used || ticketEntry.expiresAt <= now || ticketEntry.ip !== ip) {
    attempts.count += 1;
    enrollmentAttempts.set(ip, attempts);
    audit.record({ requestId: req.requestId, action: 'COMPANION_ENROLLMENT_REJECTED', clientIp: ip, outcome: 'denied' });
    return res.status(401).json({ success: false, error: 'ลิงก์ติดตั้งหมดอายุหรือใช้ไปแล้ว กรุณาดาวน์โหลด Companion ใหม่จากหน้า Install' });
  }
  ticketEntry.used = true;
  enrollmentCodes.delete(ticketHash);
  attempts.count += 1;
  enrollmentAttempts.set(ip, attempts);
  const name = String(req.body?.deviceName || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 100) || 'HOSxP workstation';
  const localIp = String(req.body?.localIp || '').trim().slice(0, 50);
  const token = crypto.randomBytes(32).toString('hex');
  const device = {
    id: crypto.randomUUID(),
    name,
    clientIp: ip,
    localIp: localIp || ip,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date(now).toISOString(),
    revokedAt: null
  };
  config.security = config.security || {};
  config.security.companionDevices = companionDeviceRecords(config);
  config.security.companionDevices.push(device);
  try {
    persistConfig(config);
    audit.record({ requestId: req.requestId, action: 'COMPANION_DEVICE_ENROLLED', actor: name, workstation: name, clientIp: ip, outcome: 'success' });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({ success: true, token, deviceId: device.id, deviceName: device.name, productVersion: PRODUCT_VERSION, build: PRODUCT_BUILD });
  } catch (error) {
    config.security.companionDevices = config.security.companionDevices.filter(item => item.id !== device.id);
    res.status(500).json({ success: false, error: 'บันทึกอุปกรณ์ไม่สำเร็จ กรุณาลองเปิด Companion อีกครั้ง' });
  }
});

app.get('/api/setup/audit', localSetupOnly, (req, res) => {
  try {
    const result = audit.listEvents();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : '';
    const action = String(req.query.action || '').slice(0, 80);
    const outcome = ['success', 'denied', 'error'].includes(String(req.query.outcome || '')) ? String(req.query.outcome) : '';
    const q = String(req.query.q || '').trim().slice(0, 120).toLocaleLowerCase();
    const filtered = result.events.filter(event => {
      const localDate = new Date(event.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      if (from && localDate < from) return false;
      if (to && localDate > to) return false;
      if (action && event.action !== action) return false;
      if (outcome && event.outcome !== outcome) return false;
      if (q && ![event.actor, event.workstation, event.client_ip, event.action, event.resource_type, event.resource_ref]
        .some(value => String(value || '').toLocaleLowerCase().includes(q))) return false;
      return true;
    });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.min(Math.max(Number.parseInt(req.query.offset, 10) || 0, 0), 1000000);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({
      success: true,
      events: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      sources: {
        sqlite: result.sqliteCount,
        sqliteAvailable: result.sqliteAvailable,
        sqliteTruncated: result.sqliteTruncated,
        jsonl: result.fallbackCount,
        jsonlAvailable: result.fallbackAvailable,
        jsonlTruncated: result.fallbackTruncated
      },
      productVersion: PRODUCT_VERSION,
      build: PRODUCT_BUILD
    });
  } catch (error) {
    console.error('[Audit] viewer could not read logs:', error.code || error.name || 'error');
    res.status(500).json({ success: false, error: 'อ่านประวัติระบบไม่สำเร็จ ตรวจสอบไฟล์ audit log และสิทธิ์เข้าถึง' });
  }
});

app.post('/api/setup/test-database', localSetupOnly, async (req, res) => {
  try {
    const settings = req.body?.hosxp || {};
    if (!settings.host || !settings.database || !settings.user) return res.status(400).json({ success: false, error: 'กรอก Host, Database และ User ให้ครบ' });
    const previous = db.getConfig();
    if (!settings.password && previous?.hosxp?.password) settings.password = previous.hosxp.password;
    res.json(await db.testConnection(settings));
  } catch (error) {
    res.status(400).json({ success: false, error: `ตรวจสอบฐานข้อมูลไม่ผ่าน: ${error.message}`, readOnly: false, grantDetails: error.grantCheck || null });
  }
});

app.post('/api/setup/save', localSetupOnly, async (req, res) => {
  try {
    const body = req.body || {};
    const old = db.getConfig();
    const h = body.hosxp || {};
    if (!h.host || !h.database || !h.user) return res.status(400).json({ success: false, error: 'กรอกค่าฐานข้อมูล HOSxP ให้ครบ' });
    if (!h.password && old?.hosxp?.password) h.password = old.hosxp.password;
    const dbCheck = await db.testConnection(h);
    const parsedAllow = String(body.allowedLanSubnets || '127.0.0.1,::1')
      .split(/[,;\s]+/)
      .map(item => item.trim().replace(/^[;,]+|[;,]+$/g, ''))
      .filter(Boolean);
    const allow = Array.from(new Set(['127.0.0.1', '::1', ...parsedAllow]));
    const config = {
      port: Math.min(Math.max(Number(body.port) || 3030, 1), 65535),
      hospitalName: String(body.hospitalName || '').trim().slice(0, 120),
      hospitalCode: String(body.hospitalCode || '').trim().slice(0, 20),
      hosxp: { host: String(h.host).trim(), port: Number(h.port) || 3306, database: String(h.database).trim(), user: String(h.user).trim(), password: String(h.password || ''), connectionLimit: 10 },
      security: {
        allowedLanSubnets: allow,
        allowInsecureEnrollment: body.allowInsecureEnrollment !== undefined ? Boolean(body.allowInsecureEnrollment) : true,
        allowRemoteSetup: body.allowRemoteSetup !== undefined ? Boolean(body.allowRemoteSetup) : (old?.security?.allowRemoteSetup || false),
        apiKey: old?.security?.apiKey || '',
        companionToken: old?.security?.companionToken || crypto.randomBytes(32).toString('hex'),
        companionDevices: old?.security?.companionDevices || [],
        auditHashKey: old?.security?.auditHashKey || crypto.randomBytes(32).toString('hex')
      },
      schema: {
        creatinineLabCode: String(body.creatinineLabCode || '155').trim(),
        searchCharset: ['tis620', 'utf8mb4'].includes(String(body.searchCharset).toLowerCase()) ? String(body.searchCharset).toLowerCase() : 'tis620',
        labTrendCodes: Object.fromEntries(['ldl', 'hct', 'platelet', 'uacr', 'potassium', 'sodium', 'bun', 'ast', 'alt', 'uric'].map(key => [key,
          [...new Set(String(body.labTrendCodes?.[key] || '').split(',').map(code => code.trim()).filter(code => /^[A-Za-z0-9._-]{1,30}$/.test(code)))].slice(0, 20)
        ]))
      }
    };
    await db.closePool();
    fs.mkdirSync(path.dirname(db.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(db.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    audit.record({ action: old ? 'SETUP_UPDATED' : 'SETUP_INITIALIZED', actor: 'local-setup', outcome: 'success' });
    const portChanged = Number(httpServer?.address()?.port) !== config.port;
    res.json({ success: true, message: portChanged ? 'บันทึกค่าแล้ว กำลังเปลี่ยนพอร์ตบริการ' : 'บันทึกค่าและเริ่มระบบเรียบร้อย', port: config.port, restartRequired: portChanged, databaseReadOnly: dbCheck.readOnly, productVersion: PRODUCT_VERSION, build: PRODUCT_BUILD });
    if (portChanged) {
      setTimeout(() => httpServer.close(() => startServer(config.port)), 500);
    }
  } catch (error) {
    audit.record({ requestId: req.requestId, action: 'SETUP_UPDATE', actor: 'local-setup', outcome: 'denied' });
    res.status(400).json({ success: false, error: `บันทึกการตั้งค่าไม่สำเร็จ: ${error.message}`, grantDetails: error.grantCheck || null });
  }
});

app.use('/setup', localSetupOnly, express.static(path.join(PUBLIC, 'setup')));
app.get('/setup', localSetupOnly, (req, res) => res.sendFile(path.join(PUBLIC, 'setup', 'index.html')));

function installNetworkOnly(req, res, next) {
  const config = db.getConfig();
  if (!config) return res.status(503).send('Server ยังไม่ได้ตั้งค่า');
  if (!isAllowed(req, config)) return res.status(403).send('เครือข่ายนี้ไม่ได้รับอนุญาต');
  return next();
}

app.get('/install/companion-setup.exe', installNetworkOnly, (req, res) => {
  if (!isLocal(req) && !secureForEnrollment(req)) return res.status(426).send('การติดตั้งจากเครื่องอื่นต้องเปิดผ่าน HTTPS');
  const { ticket } = createInstallTicket(requestClientIp(req));
  return res.redirect(302, `/install/companion.exe?ticket=${encodeURIComponent(ticket)}`);
});

app.get('/install/companion.exe', installNetworkOnly, (req, res) => {
  if (!isLocal(req) && !secureForEnrollment(req)) return res.status(426).send('การติดตั้งจากเครื่องอื่นต้องเปิดผ่าน HTTPS');
  const release = getLatestCompanionRelease();
  if (!release || !fs.existsSync(release.fullPath)) return res.status(404).send('ยังไม่มีไฟล์ Companion สำหรับรุ่นนี้');
  res.set('Cache-Control', 'no-store');
  res.download(release.fullPath, release.name);
});

app.use('/install', installNetworkOnly, express.static(path.join(PUBLIC, 'install')));

app.use('/api', (req, res, next) => {
  // Patient lookup results must always reflect the current database response,
  // never a cached empty result from an earlier search attempt.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  const config = db.getConfig();
  if (!config) return res.status(503).json({ success: false, error: 'ยังไม่ได้ตั้งค่าระบบ กรุณาเปิดหน้า Setup บนเครื่อง Server' });
  if (!isAllowed(req, config)) {
    audit.record({ requestId: req.requestId, action: 'API_ACCESS_DENIED', clientIp: requestClientIp(req), outcome: 'denied' });
    return res.status(403).json({ success: false, error: 'เครื่องนี้ไม่ได้อยู่ในวงเครือข่ายที่อนุญาต' });
  }
  // These endpoints carry Companion's short-lived HOSxP session heartbeat or report the lock state.
  if (req.path.endsWith('/sync-patient') || req.path.endsWith('/notify-patient') || req.path.endsWith('/version') || req.path.endsWith('/auth/login') || req.path.endsWith('/auth/logout')) return next();
  const clientIp = requestClientIp(req);
  const companion = companionSessions.get(clientIp);
  if (companion?.active && Date.now() - companion.timestamp <= 15000) {
    const replacedManual = clearManualSession(req, res);
    if (replacedManual) audit.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_SESSION_REPLACED_BY_COMPANION', actor: replacedManual.user, workstation: companion.computer, clientIp, outcome: 'success' });
    req.assistantSession = { ...companion, authType: 'companion' };
    return next();
  }
  const manual = getManualSession(req, true);
  if (manual) {
    req.assistantSession = { user: manual.user, displayName: manual.displayName, authType: 'manual' };
    return next();
  }
  if (!companion || !companion.active || Date.now() - companion.timestamp > 15000) {
    audit.record({ requestId: req.requestId, action: 'API_SESSION_REQUIRED', clientIp: requestClientIp(req), outcome: 'denied' });
    return res.status(423).json({ success: false, locked: true, error: 'ต้องเปิดและเข้าสู่ระบบ HOSxP พร้อม Companion ก่อนใช้งาน' });
  }
  req.assistantSession = { ...companion, authType: 'companion' };
  next();
});

// All clinical endpoints are owned by this product; no Paperless or Writer routes are mounted.
const assistantApi = require('./routes/assistant');
app.set('companionSessions', companionSessions);
app.set('manualSessions', manualSessions);
app.set('getManualSession', getManualSession);
app.set('clearManualSession', clearManualSession);
app.set('setSessionCookie', setSessionCookie);
app.set('requestClientIp', requestClientIp);
app.set('requestIsSecure', requestIsSecure);
app.set('productVersion', PRODUCT_VERSION);
app.set('productBuild', PRODUCT_BUILD);
app.set('companionToken', () => db.getConfig()?.security?.companionToken || '');
app.set('authenticateCompanionToken', (providedToken, clientIp) => {
  const normalized = String(providedToken || '').trim().toLowerCase();
  const config = db.getConfig() || {};
  const sharedToken = String(config.security?.companionToken || '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(sharedToken) && /^[a-f0-9]{64}$/.test(normalized)) {
    const provided = Buffer.from(normalized);
    const expected = Buffer.from(sharedToken);
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) return { valid: true, deviceId: '', deviceName: '' };
  }
  if (/^[a-f0-9]{64}$/.test(normalized)) {
    const tokenHash = crypto.createHash('sha256').update(normalized).digest();
    for (const device of companionDeviceRecords(config)) {
      if (device.revokedAt || !/^[a-f0-9]{64}$/i.test(String(device.tokenHash || ''))) continue;
      const expectedHash = Buffer.from(String(device.tokenHash).toLowerCase(), 'hex');
      if (tokenHash.length === expectedHash.length && crypto.timingSafeEqual(tokenHash, expectedHash)) {
        return { valid: true, deviceId: device.id, deviceName: device.name || '' };
      }
    }
  }
  if (clientIp && config?.security?.allowInsecureEnrollment !== false) {
    const rules = Array.isArray(config?.security?.allowedLanSubnets) ? config.security.allowedLanSubnets : [];
    const isLanAllowed = rules.some(rule => rule && (rule.endsWith('.') ? clientIp.startsWith(rule) : clientIp === rule));
    if (isLanAllowed) {
      return { valid: true, deviceId: 'lan-' + clientIp, deviceName: 'Workstation ' + clientIp };
    }
  }
  return { valid: false };
});
app.use('/api/assistant', assistantApi);
app.use('/api', assistantApi);

app.use('/assistant', express.static(path.join(PUBLIC, 'assistant')));
app.get('/assistant', (req, res) => res.sendFile(path.join(PUBLIC, 'assistant', 'index.html')));
app.get('/', (req, res) => res.redirect('/assistant/'));
app.use(express.static(PUBLIC));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

let httpServer;
function startServer(port) {
  httpServer = app.listen(port, '0.0.0.0', () => {
    console.log(`[Doctor Assistant v${PRODUCT_VERSION} build ${PRODUCT_BUILD}] listening on port ${port}`);
    console.log(`Setup: http://localhost:${port}/setup (local Server only)`);
  });
}
const config = db.getConfig();
startServer(Number(config?.port) || Number(process.env.PORT) || 3030);