'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const db = require('./db');

const app = express();
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '64kb' }));

function cleanIp(value) {
  let ip = String(value || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip === '::1' ? '127.0.0.1' : ip;
}

function isLocal(req) {
  const ip = cleanIp(req.socket?.remoteAddress || req.ip);
  return ip === '127.0.0.1' || ip === 'localhost' || !ip;
}

function isAllowed(req, config) {
  const ip = cleanIp(req.socket?.remoteAddress || req.ip);
  const security = config?.security || {};
  const rules = Array.isArray(security.allowedLanSubnets) ? security.allowedLanSubnets : [];
  if (rules.some(rule => rule && (rule.endsWith('.') ? ip.startsWith(rule) : ip === rule))) return true;
  const key = security.apiKey;
  return Boolean(key && req.get('x-api-key') === key);
}

function localSetupOnly(req, res, next) {
  if (isLocal(req)) return next();
  return res.status(403).json({ success: false, error: 'หน้า Setup เปิดได้จากเครื่อง Server เท่านั้น (ใช้ http://localhost:<port>/setup)' });
}

app.get('/health', (req, res) => res.json({ status: 'ok', configured: !!db.getConfig(), time: new Date().toISOString() }));

app.get('/api/setup/status', localSetupOnly, (req, res) => {
  const config = db.getConfig();
  res.json({ configured: !!config, config: config ? {
    port: config.port,
    hospitalName: config.hospitalName || '',
    hospitalCode: config.hospitalCode || '',
    hosxp: { host: config.hosxp?.host || '', port: config.hosxp?.port || 3306, database: config.hosxp?.database || '', user: config.hosxp?.user || '' },
    security: { allowedLanSubnets: config.security?.allowedLanSubnets || ['127.0.0.1', '::1'] },
    schema: { creatinineLabCode: config.schema?.creatinineLabCode || '155', searchCharset: config.schema?.searchCharset || 'tis620' }
  } : null });
});

app.post('/api/setup/test-database', localSetupOnly, async (req, res) => {
  try {
    const settings = req.body?.hosxp || {};
    if (!settings.host || !settings.database || !settings.user) return res.status(400).json({ success: false, error: 'กรอก Host, Database และ User ให้ครบ' });
    const previous = db.getConfig();
    if (!settings.password && previous?.hosxp?.password) settings.password = previous.hosxp.password;
    res.json(await db.testConnection(settings));
  } catch (error) {
    res.status(400).json({ success: false, error: `เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ${error.message}` });
  }
});

app.post('/api/setup/save', localSetupOnly, async (req, res) => {
  try {
    const body = req.body || {};
    const old = db.getConfig();
    const h = body.hosxp || {};
    if (!h.host || !h.database || !h.user) return res.status(400).json({ success: false, error: 'กรอกค่าฐานข้อมูล HOSxP ให้ครบ' });
    if (!h.password && old?.hosxp?.password) h.password = old.hosxp.password;
    await db.testConnection(h);
    const allow = String(body.allowedLanSubnets || '127.0.0.1,::1').split(',').map(item => item.trim()).filter(Boolean);
    const config = {
      port: Math.min(Math.max(Number(body.port) || 3030, 1), 65535),
      hospitalName: String(body.hospitalName || '').trim().slice(0, 120),
      hospitalCode: String(body.hospitalCode || '').trim().slice(0, 20),
      hosxp: { host: String(h.host).trim(), port: Number(h.port) || 3306, database: String(h.database).trim(), user: String(h.user).trim(), password: String(h.password || ''), connectionLimit: 10 },
      security: { allowedLanSubnets: allow, apiKey: old?.security?.apiKey || '' },
      schema: {
        creatinineLabCode: String(body.creatinineLabCode || '155').trim(),
        searchCharset: ['tis620', 'utf8mb4'].includes(String(body.searchCharset).toLowerCase()) ? String(body.searchCharset).toLowerCase() : 'tis620'
      }
    };
    await db.closePool();
    fs.mkdirSync(path.dirname(db.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(db.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const portChanged = Number(httpServer?.address()?.port) !== config.port;
    res.json({ success: true, message: portChanged ? 'บันทึกค่าแล้ว กำลังเปลี่ยนพอร์ตบริการ' : 'บันทึกค่าและเริ่มระบบเรียบร้อย', port: config.port, restartRequired: portChanged });
    if (portChanged) {
      setTimeout(() => httpServer.close(() => startServer(config.port)), 500);
    }
  } catch (error) {
    res.status(400).json({ success: false, error: `บันทึกการตั้งค่าไม่สำเร็จ: ${error.message}` });
  }
});

app.use('/setup', localSetupOnly, express.static(path.join(PUBLIC, 'setup')));
app.get('/setup', localSetupOnly, (req, res) => res.sendFile(path.join(PUBLIC, 'setup', 'index.html')));

app.use('/api', (req, res, next) => {
  // Patient lookup results must always reflect the current database response,
  // never a cached empty result from an earlier search attempt.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  const config = db.getConfig();
  if (!config) return res.status(503).json({ success: false, error: 'ยังไม่ได้ตั้งค่าระบบ กรุณาเปิดหน้า Setup บนเครื่อง Server' });
  if (!isAllowed(req, config)) return res.status(403).json({ success: false, error: 'เครื่องนี้ไม่ได้อยู่ในวงเครือข่ายที่อนุญาต' });
  next();
});

// All clinical endpoints are owned by this product; no Paperless or Writer routes are mounted.
const assistantApi = require('./routes/assistant');
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
    console.log(`[Doctor Assistant] listening on port ${port}`);
    console.log(`Setup: http://localhost:${port}/setup (local Server only)`);
  });
}
const config = db.getConfig();
startServer(Number(config?.port) || Number(process.env.PORT) || 3030);
