'use strict';

const express = require('express');
const { getPool, getConfig } = require('../db');
const auditLog = require('../audit-log');
const router = express.Router();
const activePatients = new Map();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function clientIp(req) {
  const resolveIp = req.app?.get('requestClientIp');
  if (typeof resolveIp === 'function') return resolveIp(req);
  let ip = String(req.ip || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function isExplicitNoAllergy(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\u200b\uFEFF]+/g, '');
  return /^(?:ปฏิเสธ|ปฎิเสธ)(?:การ)?แพ้/.test(text)
    || /^(?:ไม่มีประวัติแพ้ยา|ไม่เคยแพ้ยา|ไม่มี|ไม่แพ้ยา|n\/?a|none|n|no)(?:$|[\/,;|])/.test(text);
}

function audit(req, action, patient = {}) {
  const session = req.assistantSession || {};
  return auditLog.record({
    requestId: req.requestId, action, actor: session.user || '',
    workstation: session.computer || req.get('x-workstation') || '', clientIp: clientIp(req),
    resourceType: patient.vn ? 'visit' : patient.hn ? 'patient' : '',
    resourceRef: patient.vn || patient.hn || '', outcome: 'success'
  });
}

function thaiDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getDate()} ${['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'][date.getMonth()]} ${date.getFullYear() + 543}`;
}

function thaiDateFull(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getDate()} ${['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'][date.getMonth()]} ${date.getFullYear() + 543}`;
}

function capLimit(value, fallback = 10) {
  return Math.min(Math.max(parseInt(value, 10) || fallback, 1), 100);
}

function egfr2021(creatinine, age, sex) {
  const cr = Number(creatinine), years = Number(age);
  if (!(cr > 0) || !(years > 0)) return null;
  const female = String(sex) === '2' || String(sex).toLowerCase() === 'female';
  const k = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  return 142 * Math.pow(Math.min(cr / k, 1), alpha) * Math.pow(Math.max(cr / k, 1), -1.2) * Math.pow(0.9938, years) * (female ? 1.012 : 1);
}

function loginRateState(ip, now = Date.now()) {
  let state = loginAttempts.get(ip);
  if (!state || now - state.windowStartedAt >= LOGIN_WINDOW_MS) {
    state = { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    loginAttempts.set(ip, state);
  }
  return state;
}

router.post('/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const state = loginRateState(ip);
  if (state.blockedUntil > Date.now()) {
    auditLog.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_LOGIN_RATE_LIMITED', clientIp: ip, outcome: 'denied' });
    return res.status(429).json({ success: false, error: 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' });
  }
  if (!req.app.get('requestIsSecure')(req) && ip !== '127.0.0.1') {
    return res.status(426).json({ success: false, error: 'การเข้าสู่ระบบจากเครื่องอื่นต้องใช้ HTTPS เพื่อปกป้องรหัสผ่าน' });
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password || username.length > 250 || password.length > 250) {
    return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }

  try {
    const db = getPool();
    // The site's passweb sample is 32 hex characters, and MD5 is used by some HOSxP-related web integrations.
    // Compare inside MariaDB with a prepared parameter; never select or return the stored hash.
    const [rows] = await db.execute(`SELECT loginname,name,account_disable FROM opduser
      WHERE loginname=? AND passweb IS NOT NULL AND LOWER(passweb)=LOWER(MD5(?)) LIMIT 1`, [username, password]);
    const account = rows[0];
    const disabled = account && ['Y', '1'].includes(String(account.account_disable || '').trim().toUpperCase());
    if (!account || disabled) {
      state.failures += 1;
      if (state.failures >= LOGIN_MAX_FAILURES) state.blockedUntil = Date.now() + LOGIN_WINDOW_MS;
      auditLog.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_LOGIN_FAILED', clientIp: ip, outcome: 'denied' });
      return res.status(401).json({ success: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกระงับ' });
    }

    state.failures = 0;
    state.blockedUntil = 0;
    const token = require('crypto').randomBytes(32).toString('hex');
    const sessions = req.app.get('manualSessions');
    const now = Date.now();
    sessions.set(token, { user: String(account.loginname), displayName: String(account.name || account.loginname), createdAt: now, lastActivity: now });
    req.app.get('setSessionCookie')(res, token, req);
    auditLog.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_LOGIN', actor: String(account.loginname), clientIp: ip, outcome: 'success' });
    return res.json({ success: true, user: String(account.loginname), displayName: String(account.name || account.loginname) });
  } catch (_) {
    // Keep DB diagnostics and submitted credentials out of the response and routine logs.
    auditLog.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_LOGIN_ERROR', clientIp: ip, outcome: 'error' });
    return res.status(503).json({ success: false, error: 'ตรวจสอบบัญชีไม่ได้ กรุณาตรวจการเชื่อมต่อฐานข้อมูลหรือสิทธิ์อ่านตาราง opduser' });
  }
});

router.post('/auth/logout', (req, res) => {
  const session = req.app.get('clearManualSession')(req, res);
  if (session) auditLog.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_LOGOUT', actor: session.user, clientIp: clientIp(req), outcome: 'success' });
  res.json({ success: true });
});

router.get('/sync-patient', (req, res) => {
  const ip = clientIp(req);
  const state = activePatients.get(ip) || (ip === '127.0.0.1' ? activePatients.get('127.0.0.1') : null);
  const alive = state && state.session_active && Date.now() - state.timestamp < 15000;
  let manual = null;
  if (alive) {
    manual = req.app.get('clearManualSession')(req, res);
    if (manual) auditLog.record({ requestId: req.requestId, action: 'HOSXP_MANUAL_SESSION_REPLACED_BY_COMPANION', actor: manual.user, workstation: state.computer, clientIp: ip, outcome: 'success' });
  } else {
    manual = req.app.get('getManualSession')(req, false);
  }
  if (manual) {
    return res.json({ vn: null, hn: null, user: manual.displayName || manual.user, live_diag: '', last_click_id: 0, last_click_vn: '', isLive: false, sessionActive: true, authMode: 'manual', timestamp: Date.now() });
  }
  res.json({
    vn: alive ? state.vn || null : null,
    hn: alive ? state.hn || null : null,
    user: alive ? state.user || '' : '',
    live_diag: alive ? state.live_diag || '' : '',
    last_click_id: state?.last_click_id || 0,
    last_click_vn: state?.last_click_vn || '',
    isLive: !!(alive && state.vn),
    sessionActive: !!alive,
    authMode: alive ? 'companion' : '',
    timestamp: Date.now()
  });
});

router.post('/notify-patient', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  const ip = clientIp(req);
  const providedToken = String(req.get('x-companion-token') || '');
  const companionAuth = req.app.get('authenticateCompanionToken')(providedToken);
  if (!companionAuth.valid) {
    auditLog.record({ requestId: req.requestId, action: 'COMPANION_HEARTBEAT_REJECTED', clientIp: ip, outcome: 'denied' });
    return res.status(401).json({ success: false, error: 'Companion ไม่ได้รับอนุญาต' });
  }
  const sessionActive = body.session_active === true && Boolean(String(body.user || '').trim());
  const previous = activePatients.get(ip) || {};
  const isClick = body.trigger === 'click' || body.click_id;
  const state = {
    vn: sessionActive ? String(body.vn || '') : '', hn: sessionActive ? String(body.hn || '') : '', user: sessionActive ? String(body.user || '').slice(0, 100) : '',
    live_diag: String(body.live_diag || previous.live_diag || ''),
    computer: String(companionAuth.deviceName || body.computer || '').slice(0, 100), device_id: companionAuth.deviceId || '', session_active: sessionActive,
    last_click_id: Number(body.click_id) || (isClick ? Date.now() : previous.last_click_id || 0),
    last_click_vn: isClick ? String(body.vn || '') : previous.last_click_vn || '',
    timestamp: Date.now()
  };
  const sessionChanged = Boolean(previous.session_active) !== sessionActive || (sessionActive && previous.user !== state.user);
  const patientChanged = (previous.vn || '') !== state.vn || (previous.hn || '') !== state.hn;
  activePatients.set(ip, state);
  const sessions = req.app.get('companionSessions');
  if (sessionActive) sessions.set(ip, { active: true, user: state.user, computer: state.computer, deviceId: state.device_id, timestamp: state.timestamp });
  else sessions.delete(ip);
  if (ip === '127.0.0.1') activePatients.set('127.0.0.1', state);
  if (sessionChanged) auditLog.record({ requestId: req.requestId, action: sessionActive ? 'HOSXP_SESSION_STARTED' : 'HOSXP_SESSION_ENDED', actor: state.user || previous.user, workstation: state.computer, clientIp: ip, outcome: 'success' });
  if (patientChanged && (previous.vn || previous.hn || state.vn || state.hn)) auditLog.record({ requestId: req.requestId, action: state.vn || state.hn ? 'PATIENT_CONTEXT_SELECTED' : 'PATIENT_CONTEXT_CLEARED', actor: state.user || previous.user, workstation: state.computer || previous.computer, clientIp: ip, resourceType: state.vn || previous.vn ? 'visit' : 'patient', resourceRef: state.vn || previous.vn || state.hn || previous.hn, outcome: 'success' });
  res.json({ success: true, vn: state.vn, timestamp: state.timestamp, last_click_id: state.last_click_id });
});

router.get('/visit-data/:vn', async (req, res) => {
  const vn = String(req.params.vn || '');
  if (!/^\d+$/.test(vn)) return res.status(400).json({ success: false, error: 'รูปแบบ VN ไม่ถูกต้อง' });
  try {
    const db = getPool();
    const [visits] = await db.execute(`
      SELECT o.vn,o.hn,DATE_FORMAT(o.vstdate,'%Y-%m-%d') AS vstdate,o.vsttime,o.oqueue,o.spclty,o.diag_text,
        o.doctor AS doctor_code,IFNULL(d.name,'') AS doctor_name,o.main_dep,o.cur_dep,
        IFNULL(k.department,'ห้องตรวจแพทย์') AS main_dep_name,IFNULL(pt.name,'') AS pttype_name
      FROM ovst o LEFT JOIN doctor d ON o.doctor=d.code
      LEFT JOIN kskdepartment k ON o.main_dep=k.depcode LEFT JOIN pttype pt ON o.pttype=pt.pttype
      WHERE o.vn=? LIMIT 1`, [vn]);
    if (!visits.length) return res.status(404).json({ success: false, error: 'ไม่พบ Visit ใน HOSxP' });
    const visit = visits[0];
    const [[patients], [stats], [screens], [diagnoses], [medRows], [labHeads]] = await Promise.all([
      db.execute(`SELECT hn,cid,CONCAT(IFNULL(pname,''),fname,' ',lname) AS name,sex,
        TIMESTAMPDIFF(YEAR,birthday,CURDATE()) AS age,DATE_FORMAT(birthday,'%Y-%m-%d') AS birthday,drugallergy
        FROM patient WHERE hn=? LIMIT 1`, [visit.hn]),
      db.execute('SELECT age_y,age_m FROM vn_stat WHERE vn=? LIMIT 1', [vn]),
      db.execute(`SELECT cc,hpi,pmh,fh,sh,pe,bps,bpd,pulse,rr,temperature,bw,height,bmi,waist,spo2,fbs,pefr,pain_score,found_allergy
        FROM opdscreen WHERE vn=? LIMIT 1`, [vn]),
      db.execute(`SELECT od.icd10,od.diagtype,od.dx_code_note,IFNULL(i.name,'') AS name FROM ovstdiag od
        LEFT JOIN icd101 i ON od.icd10=i.code WHERE od.vn=? ORDER BY od.diagtype`, [vn]),
      db.execute(`SELECT o.icode,d.name,d.strength,d.units,o.qty,
        CONCAT(IFNULL(u.name1,''),' ',IFNULL(u.name2,''),' ',IFNULL(u.name3,'')) AS drug_usage
        FROM opitemrece o LEFT JOIN drugitems d ON o.icode=d.icode
        LEFT JOIN drugusage u ON o.drugusage=u.drugusage WHERE o.vn=? ORDER BY o.item_no`, [vn]),
      db.execute(`SELECT lab_order_number,form_name,reporter_name FROM lab_head
        WHERE vn=? AND confirm_report='Y' ORDER BY lab_order_number`, [vn])
    ]);
    const patient = patients[0] || {};
    const screening = screens[0] || {};
    let allergyRows = [];
    try {
      const [allergyColumns] = await db.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='opd_allergy'`);
      const available = new Set(allergyColumns.map(column => String(column.COLUMN_NAME).toLowerCase()));
      if (available.has('hn') && available.has('agent')) {
        const fields = ['agent'];
        for (const optional of ['symptom', 'report_date', 'seriousness_id']) {
          if (available.has(optional)) fields.push(optional);
        }
        const orderBy = available.has('report_date') ? 'ORDER BY report_date DESC' : '';
        const [rows] = await db.execute(`SELECT ${fields.join(',')} FROM opd_allergy WHERE hn=? ${orderBy}`, [visit.hn]);
        allergyRows = rows.map(row => ({
          agent: String(row.agent || '').trim(),
          symptom: String(row.symptom || '').trim(),
          report_date: row.report_date || null,
          severity: row.seriousness_id ?? null
        })).filter(row => row.agent || row.symptom);
      }
    } catch (allergyError) {
      console.warn('[assistant] allergy history unavailable:', allergyError.code || allergyError.name || 'error');
    }
    const fallbackAllergy = String(patient.drugallergy || '').trim();
    const screeningAllergy = String(screening.found_allergy || '').trim();
    // HOSxP may store a refusal/no-known-allergy statement in opd_allergy.agent.
    // Such a row is not a positive allergen and must not trigger the red warning.
    const negativeAllergyRows = allergyRows.filter(row =>
      isExplicitNoAllergy(row.agent) || (!row.agent && isExplicitNoAllergy(row.symptom))
    );
    const positiveAllergyRows = allergyRows.filter(row => !negativeAllergyRows.includes(row));
    const fallbackSaysNoAllergy = isExplicitNoAllergy(fallbackAllergy);
    const screeningSaysNoAllergy = isExplicitNoAllergy(screeningAllergy);
    const fallbackHasAllergyText = Boolean(fallbackAllergy && !fallbackSaysNoAllergy);
    const allergyStatus = positiveAllergyRows.length || fallbackHasAllergyText
      ? 'recorded'
      : (negativeAllergyRows.length || fallbackSaysNoAllergy || screeningSaysNoAllergy ? 'none' : 'unknown');
    const negativeAllergyText = negativeAllergyRows
      .map(row => [row.agent, row.symptom].filter(Boolean).join(': '))
      .filter(Boolean)
      .join(' · ');
    const rawNegativeText = negativeAllergyText || (fallbackSaysNoAllergy ? fallbackAllergy : screeningAllergy);
    const cleanNegativeText = (/^(n|no|none|u|unknown|-)$/i.test(rawNegativeText.trim()))
      ? 'ไม่พบประวัติการแพ้ยาในระบบ (โปรดยืนยันกับผู้ป่วยก่อนสั่งยา)'
      : (rawNegativeText || 'ไม่พบประวัติการแพ้ยาในระบบ (โปรดยืนยันกับผู้ป่วยก่อนสั่งยา)');

    const allergyText = positiveAllergyRows.length
      ? positiveAllergyRows.map(row => [row.agent, row.symptom].filter(Boolean).join(': ')).join(' · ')
      : (fallbackHasAllergyText ? fallbackAllergy : cleanNegativeText);
    const age = Number(stats[0]?.age_y ?? patient.age ?? 0);
    const [creatinineRows] = await db.execute(`SELECT lo.lab_order_result FROM lab_head lh
      JOIN lab_order lo ON lo.lab_order_number=lh.lab_order_number
      WHERE lh.hn=? AND lo.lab_items_code=? AND lo.lab_order_result REGEXP '^[0-9]+(\\.[0-9]+)?$'
      ORDER BY lh.order_date DESC,lh.order_time DESC LIMIT 1`, [visit.hn, String(getConfig()?.schema?.creatinineLabCode || '155')]);
    const creatinine = Number(creatinineRows[0]?.lab_order_result) || null;
    const egfr = egfr2021(creatinine, age, patient.sex);
    const crcl = creatinine && age ? ((140 - age) * (Number(screening.bw) || 56.7) * (String(patient.sex) === '2' ? 0.85 : 1)) / (72 * creatinine) : null;
    const diagnosesOut = diagnoses.map(row => ({ ...row, type_name: row.diagtype === '1' ? 'PDx' : row.diagtype === '2' ? 'SDx' : 'Other' }));
    const medications = medRows.filter(row => row.name).map(row => ({ icode: row.icode, name: row.name, strength: row.strength || '', units: row.units || '', qty: row.qty, usage: String(row.drug_usage || '').trim() }));
    const labResults = [];
    for (const head of labHeads) {
      const [items] = await db.execute(`SELECT lo.lab_items_code AS code,lo.lab_order_result AS result,
        lo.abnormal_result,lo.critical_result,lo.lab_items_normal_value_ref,li.lab_items_name AS name,
        li.lab_items_unit AS unit,li.lab_items_normal_value AS normal_value
        FROM lab_order lo LEFT JOIN lab_items li ON lo.lab_items_code=li.lab_items_code
        WHERE lo.lab_order_number=? AND lo.lab_order_result IS NOT NULL AND lo.lab_order_result!=''`, [head.lab_order_number]);
      if (items.length) labResults.push({ form_name: head.form_name || 'ผลตรวจทางห้องปฏิบัติการ', reporter_name: head.reporter_name || '', items: items.map(item => ({
        ...item, abnormal: item.abnormal_result === 'Y', critical: item.critical_result === 'Y', normal_value: item.lab_items_normal_value_ref || item.normal_value || ''
      })) });
    }
    let appointment = null;
    try {
      const [apps] = await db.execute(`SELECT DATE_FORMAT(a.nextdate,'%Y-%m-%d') AS nextdate,a.nexttime,a.endtime,a.nexttime_end,
        DATEDIFF(a.nextdate,o.vstdate) AS days_count,a.clinic,a.app_cause,a.note
        FROM oapp a LEFT JOIN ovst o ON o.vn=a.vn WHERE a.vn=? ORDER BY a.oapp_id DESC LIMIT 1`, [vn]);
      if (apps[0]) appointment = { ...apps[0], nextdate_thai: thaiDate(apps[0].nextdate), nexttime: String(apps[0].nexttime || '08:00').slice(0,5), clinic_name: apps[0].clinic || 'คลินิกผู้ป่วยนอก' };
    } catch (_) { /* Some HOSxP deployments do not grant access to appointment tables. */ }

    let erRevisit48h = null;
    try {
      const [erRows] = await db.execute(`
        SELECT o.vn, o.hn, DATE_FORMAT(o.vstdate, '%Y-%m-%d') AS vstdate, o.vsttime,
               IFNULL(k.department, 'อุบัติเหตุ ฉุกเฉินER') AS department_name,
               IFNULL(o.diag_text, '') AS diag_text,
               IFNULL(s.cc, '') AS cc,
               IFNULL(d.name, '') AS doctor_name,
               TIMESTAMPDIFF(HOUR, CONCAT(o.vstdate, ' ', IFNULL(o.vsttime, '00:00:00')), NOW()) AS hours_ago
        FROM ovst o
        LEFT JOIN kskdepartment k ON o.main_dep = k.depcode
        LEFT JOIN opdscreen s ON o.vn = s.vn
        LEFT JOIN doctor d ON o.doctor = d.code
        WHERE o.hn = ?
          AND o.vn != ?
          AND (k.department LIKE '%ฉุกเฉิน%' OR k.department LIKE '%ER%' OR o.main_dep = '003' OR o.cur_dep = '003')
          AND TIMESTAMPDIFF(HOUR, CONCAT(o.vstdate, ' ', IFNULL(o.vsttime, '00:00:00')), NOW()) BETWEEN 0 AND 48
        ORDER BY o.vstdate DESC, o.vsttime DESC
        LIMIT 1
      `, [visit.hn, vn]);
      if (erRows[0]) {
        const er = erRows[0];
        erRevisit48h = {
          hasRevisit: true,
          vn: String(er.vn),
          vstdate: er.vstdate,
          vstdate_thai: thaiDate(er.vstdate),
          vsttime: er.vsttime ? String(er.vsttime).slice(0, 5) : '',
          hoursAgo: Math.max(0, Number(er.hours_ago) || 0),
          department: String(er.department_name || 'ห้องฉุกเฉิน'),
          diag: String(er.diag_text || ''),
          cc: String(er.cc || ''),
          doctor: String(er.doctor_name || '')
        };
      }
    } catch (erErr) {
      console.warn('[assistant] ER revisit check error:', erErr.code || erErr.name || 'error');
    }
    // 1. IPD Readmission within 28 days
    let readmission28d = null;
    try {
      const [ipdRows] = await db.execute(`
        SELECT i.an, i.hn,
               DATE_FORMAT(i.regdate, '%Y-%m-%d') AS regdate,
               DATE_FORMAT(i.dchdate, '%Y-%m-%d') AS dchdate,
               i.dchtime,
               IFNULL(w.name, 'หอผู้ป่วยใน') AS ward_name,
               IFNULL(d.name, '') AS doctor_name,
               IFNULL(a.pdx, '') AS pdx,
               IFNULL(ic.name, '') AS pdx_name,
               IFNULL(i.prediag, '') AS prediag,
               DATEDIFF(?, i.dchdate) AS days_since_dch
        FROM ipt i
        LEFT JOIN ward w ON i.ward = w.ward
        LEFT JOIN doctor d ON i.dch_doctor = d.code
        LEFT JOIN an_stat a ON i.an = a.an
        LEFT JOIN icd101 ic ON a.pdx = ic.code
        WHERE i.hn = ?
          AND i.dchdate IS NOT NULL
          AND i.dchdate <= ?
          AND DATEDIFF(?, i.dchdate) BETWEEN 0 AND 28
          AND (i.dchstts NOT IN ('08', '09') OR i.dchstts IS NULL)
          AND (i.dchtype NOT IN ('08', '09') OR i.dchtype IS NULL)
        ORDER BY i.dchdate DESC, i.dchtime DESC
        LIMIT 1
      `, [visit.vstdate, visit.hn, visit.vstdate, visit.vstdate]);
      if (ipdRows[0]) {
        const ipd = ipdRows[0];
        const diagDesc = ipd.pdx_name ? `${ipd.pdx}: ${ipd.pdx_name}` : (ipd.prediag || ipd.pdx || '');
        readmission28d = {
          hasReadmission: true,
          an: String(ipd.an),
          regdate: ipd.regdate,
          regdate_thai: thaiDate(ipd.regdate),
          dchdate: ipd.dchdate,
          dchdate_thai: thaiDate(ipd.dchdate),
          dchtime: ipd.dchtime ? String(ipd.dchtime).slice(0, 5) : '',
          daysAgo: Math.max(0, Number(ipd.days_since_dch) || 0),
          ward: String(ipd.ward_name || 'หอผู้ป่วยใน'),
          diag: String(diagDesc),
          doctor: String(ipd.doctor_name || '')
        };
      }
    } catch (ipdErr) {
      console.warn('[assistant] Readmission 28d check error:', ipdErr.code || ipdErr.name || 'error');
    }

    // 2. Chronic Care Gap (DM HbA1c in 6 months, UACR in 1 year)
    let careGap = { hasGap: false, gaps: [] };
    try {
      const [clinics] = await db.execute(`
        SELECT cm.clinic, c.name AS clinic_name
        FROM clinicmember cm
        JOIN clinic c ON cm.clinic = c.clinic
        WHERE cm.hn = ? AND (cm.dchdate IS NULL OR cm.dchdate = '')
      `, [visit.hn]);

      const isDm = clinics.some(c => String(c.clinic) === '001' || /เบาหวาน|dm\b/i.test(c.clinic_name));
      const isHt = clinics.some(c => String(c.clinic) === '002' || /ความดัน|ht\b/i.test(c.clinic_name));

      let hasDmDx = isDm, hasHtDx = isHt;
      if (!isDm || !isHt) {
        const [pastDx] = await db.execute(`
          SELECT icd10 FROM ovstdiag WHERE hn = ? AND (icd10 LIKE 'E10%' OR icd10 LIKE 'E11%' OR icd10 LIKE 'E14%' OR icd10 LIKE 'I10%')
          LIMIT 10
        `, [visit.hn]);
        if (pastDx.some(d => d.icd10?.startsWith('E'))) hasDmDx = true;
        if (pastDx.some(d => d.icd10?.startsWith('I10'))) hasHtDx = true;
      }

      if (hasDmDx) {
        const [hba1cRows] = await db.execute(`
          SELECT DATE_FORMAT(lh.order_date, '%Y-%m-%d') AS order_date, lo.lab_order_result, li.lab_items_name,
                 DATEDIFF(?, lh.order_date) AS days_ago
          FROM lab_head lh
          JOIN lab_order lo ON lh.lab_order_number = lo.lab_order_number
          JOIN lab_items li ON lo.lab_items_code = li.lab_items_code
          WHERE lh.hn = ?
            AND (li.lab_items_name LIKE '%a1c%' OR li.lab_items_name LIKE '%HbA1c%')
            AND lo.lab_order_result IS NOT NULL AND lo.lab_order_result != ''
          ORDER BY lh.order_date DESC
          LIMIT 1
        `, [visit.vstdate, visit.hn]);

        if (!hba1cRows[0]) {
          careGap.gaps.push({
            type: 'hba1c',
            label: 'HbA1c (น้ำตาลสะสม)',
            reason: 'ไม่พบประวัติตรวจ HbA1c ในระบบ',
            daysAgo: null,
            lastDate: null,
            lastValue: null,
            severity: 'warn'
          });
        } else if (Number(hba1cRows[0].days_ago) > 180) {
          const days = Number(hba1cRows[0].days_ago);
          const months = Math.floor(days / 30);
          careGap.gaps.push({
            type: 'hba1c',
            label: 'HbA1c (น้ำตาลสะสม)',
            reason: `ไม่ได้ตรวจเกิน ${months} เดือน (เกณฑ์: ทุก 6 เดือน)`,
            daysAgo: days,
            lastDate: thaiDate(hba1cRows[0].order_date),
            lastValue: `${hba1cRows[0].lab_order_result}%`,
            severity: 'warn'
          });
        }
      }

      const isCkd = Number(screening.egfr || 0) > 0 && Number(screening.egfr || 0) < 60;
      if (hasDmDx || hasHtDx || isCkd) {
        const [uacrRows] = await db.execute(`
          SELECT DATE_FORMAT(lh.order_date, '%Y-%m-%d') AS order_date, lo.lab_order_result, li.lab_items_name,
                 DATEDIFF(?, lh.order_date) AS days_ago
          FROM lab_head lh
          JOIN lab_order lo ON lh.lab_order_number = lo.lab_order_number
          JOIN lab_items li ON lo.lab_items_code = li.lab_items_code
          WHERE lh.hn = ?
            AND (li.lab_items_name LIKE '%uacr%' OR li.lab_items_name LIKE '%microalbumin%')
            AND lo.lab_order_result IS NOT NULL AND lo.lab_order_result != ''
          ORDER BY lh.order_date DESC
          LIMIT 1
        `, [visit.vstdate, visit.hn]);

        if (!uacrRows[0]) {
          careGap.gaps.push({
            type: 'uacr',
            label: 'UACR (โปรตีนรั่วในปัสสาวะ)',
            reason: 'ไม่พบประวัติตรวจ UACR ในระบบ',
            daysAgo: null,
            lastDate: null,
            lastValue: null,
            severity: 'info'
          });
        } else if (Number(uacrRows[0].days_ago) > 365) {
          const days = Number(uacrRows[0].days_ago);
          careGap.gaps.push({
            type: 'uacr',
            label: 'UACR (โปรตีนรั่วในปัสสาวะ)',
            reason: `ไม่ได้ตรวจเกิน 1 ปี (${Math.floor(days / 30)} เดือน, เกณฑ์: ทุกปี)`,
            daysAgo: days,
            lastDate: thaiDate(uacrRows[0].order_date),
            lastValue: uacrRows[0].lab_order_result,
            severity: 'info'
          });
        }
      }

      careGap.hasGap = careGap.gaps.length > 0;
    } catch (gapErr) {
      console.warn('[assistant] Chronic care gap check error:', gapErr.code || gapErr.name || 'error');
    }

    // 3. Recent Medications in 30 days
    let recentMeds30d = [];
    try {
      const [recMeds] = await db.execute(`
        SELECT DATE_FORMAT(o.vstdate, '%Y-%m-%d') AS vstdate, o.icode, d.name, d.strength, d.units, SUM(o.qty) AS total_qty,
               CONCAT(IFNULL(u.name1,''),' ',IFNULL(u.name2,''),' ',IFNULL(u.name3,'')) AS drug_usage,
               DATEDIFF(?, o.vstdate) AS days_ago
        FROM opitemrece o
        JOIN drugitems d ON o.icode=d.icode
        LEFT JOIN drugusage u ON o.drugusage=u.drugusage
        WHERE o.hn = ?
          AND o.vn != ?
          AND o.vstdate BETWEEN DATE_SUB(?, INTERVAL 30 DAY) AND DATE_SUB(?, INTERVAL 1 DAY)
        GROUP BY o.vstdate, o.icode, d.name, d.strength, d.units, u.name1, u.name2, u.name3
        ORDER BY o.vstdate DESC, d.name ASC
        LIMIT 15
      `, [visit.vstdate, visit.hn, vn, visit.vstdate, visit.vstdate]);
      recentMeds30d = recMeds.map(r => ({
        vstdate: r.vstdate,
        vstdate_thai: thaiDate(r.vstdate),
        daysAgo: Number(r.days_ago),
        icode: r.icode,
        name: r.name,
        strength: r.strength,
        units: r.units,
        qty: Number(r.total_qty),
        usage: r.drug_usage?.trim() || '-'
      }));
    } catch (medErr) {
      console.warn('[assistant] Recent meds check error:', medErr.code || medErr.name || 'error');
    }


    const payload = {
      success: true,
      visit: { ...visit, vstdate_thai: thaiDateFull(visit.vstdate), appointment, is_on_warfarin: /warfarin/i.test(`${patient.drugallergy || ''} ${screening.pmh || ''} ${medications.map(m => m.name).join(' ')}`) },
      patient: { ...patient, hn: visit.hn, age, age_y: age, age_text: age ? `${age} ปี ${stats[0]?.age_m ? `${stats[0].age_m} เดือน` : ''}`.trim() : '', sex: String(patient.sex) === '1' ? 'ชาย' : String(patient.sex) === '2' ? 'หญิง' : 'ไม่ระบุ' },
      allergyStatus,
      allergies: positiveAllergyRows,
      allergyText,
      erRevisit48h,
      readmission28d,
      careGap,
      recentMeds30d,
      screening: { ...screening, cr: creatinine ? creatinine.toFixed(2) : '0', egfr: egfr ? egfr.toFixed(1) : '0', crcl: crcl ? crcl.toFixed(1) : '', stage: egfr >= 90 ? '1' : egfr >= 60 ? '2' : egfr >= 30 ? '3' : egfr >= 15 ? '4' : egfr ? '5' : '-' },
      diagnoses: diagnosesOut, medications, labResults
    };
    if (!audit(req, 'ASSISTANT_VISIT', { hn: visit.hn, vn })) return res.status(503).json({ success: false, error: 'ระบบบันทึก audit ไม่พร้อม จึงระงับการส่งข้อมูลผู้ป่วยชั่วคราว' });
    res.json(payload);
  } catch (error) {
    auditLog.record({ requestId: req.requestId, action: 'ASSISTANT_VISIT', actor: req.assistantSession?.user, workstation: req.assistantSession?.computer, clientIp: clientIp(req), resourceType: 'visit', resourceRef: vn, outcome: 'error' });
    console.error('[assistant] visit-data failed:', error.code || error.name || 'error');
    res.status(500).json({ success: false, error: 'อ่านข้อมูล Visit ไม่สำเร็จ ตรวจสอบ schema และสิทธิ์ฐานข้อมูล HOSxP' });
  }
});

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = capLimit(req.query.limit, 15);
  if (!q) return res.status(400).json({ success: false, error: 'กรุณาระบุคำค้นหา', results: [] });
  try {
    const db = getPool();
    let rows;
    if (/^\d{12}$/.test(q)) {
      [rows] = await db.execute(`SELECT o.vn,o.hn,o.vstdate,p.cid,CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname) AS patient_name,
        TIMESTAMPDIFF(YEAR,p.birthday,CURDATE()) AS age,p.sex FROM ovst o LEFT JOIN patient p ON p.hn=o.hn WHERE o.vn=? LIMIT ?`, [q, limit]);
    } else if (/^\d+$/.test(q)) {
      const hn = q.padStart(7, '0');
      [rows] = await db.execute(`SELECT p.hn,p.cid,CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname) AS patient_name,
        TIMESTAMPDIFF(YEAR,p.birthday,CURDATE()) AS age,p.sex,
        (SELECT o.vn FROM ovst o WHERE o.hn=p.hn ORDER BY o.vstdate DESC,o.vsttime DESC LIMIT 1) AS vn,
        (SELECT MAX(o.vstdate) FROM ovst o WHERE o.hn=p.hn) AS vstdate
        FROM patient p WHERE p.hn=? OR p.hn LIKE ? OR p.cid LIKE ? ORDER BY p.hn=? DESC LIMIT ?`, [hn, `${q}%`, `${q}%`, hn, limit]);
    } else {
      const terms = q.split(/\s+/).filter(Boolean);
      const firstTerm = terms[0] || q;
      const lastTerm = terms[terms.length - 1] || q;
      const configuredCharset = String(getConfig()?.schema?.searchCharset || 'tis620').toLowerCase();
      const searchCharset = ['tis620', 'utf8mb4'].includes(configuredCharset) ? configuredCharset : 'tis620';
      // Send the search text as ASCII hex so the MySQL client charset cannot
      // reinterpret Thai prepared-statement parameters before SQL conversion.
      const searchValue = searchCharset === 'tis620'
        ? 'CONVERT(CONVERT(UNHEX(?) USING utf8mb4) USING tis620)'
        : 'CONVERT(UNHEX(?) USING utf8mb4)';
      const qHex = Buffer.from(q, 'utf8').toString('hex');
      const firstTermHex = Buffer.from(firstTerm, 'utf8').toString('hex');
      const lastTermHex = Buffer.from(lastTerm, 'utf8').toString('hex');
      [rows] = await db.execute(`SELECT p.hn,p.cid,CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname) AS patient_name,
        TIMESTAMPDIFF(YEAR,p.birthday,CURDATE()) AS age,p.sex,
        (SELECT o.vn FROM ovst o WHERE o.hn=p.hn ORDER BY o.vstdate DESC,o.vsttime DESC LIMIT 1) AS vn,
        (SELECT MAX(o.vstdate) FROM ovst o WHERE o.hn=p.hn) AS vstdate
        FROM patient p
        WHERE LOCATE(${searchValue},CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname))>0
          OR LOCATE(${searchValue},CONCAT(IFNULL(p.fname,''),' ',IFNULL(p.lname,'')))>0
          OR LOCATE(${searchValue},IFNULL(p.pname,''))>0
          OR LOCATE(${searchValue},IFNULL(p.fname,''))>0
          OR LOCATE(${searchValue},IFNULL(p.lname,''))>0
          OR (LOCATE(${searchValue},CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname))>0
            AND LOCATE(${searchValue},CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname))>0)
        ORDER BY CASE
          WHEN LOCATE(${searchValue},CONCAT(IFNULL(p.pname,''),p.fname,' ',p.lname))>0 THEN 1
          WHEN LOCATE(${searchValue},IFNULL(p.fname,''))>0
            OR LOCATE(${searchValue},IFNULL(p.lname,''))>0 THEN 2
          ELSE 3 END,
          vstdate DESC
        LIMIT ?`, [qHex, qHex, qHex, qHex, qHex, firstTermHex, lastTermHex, qHex, firstTermHex, lastTermHex, limit]);
    }
    if (!audit(req, 'ASSISTANT_SEARCH')) return res.status(503).json({ success: false, error: 'ระบบบันทึก audit ไม่พร้อม จึงระงับการค้นหาชั่วคราว', results: [] });
    res.json({ success: true, total: rows.length, patient: rows[0] || null, vn: rows[0]?.vn || null, results: rows.map(row => ({ ...row, vstdate_formatted: row.vstdate || '' })) });
  } catch (error) {
    auditLog.record({ requestId: req.requestId, action: 'ASSISTANT_SEARCH', actor: req.assistantSession?.user, workstation: req.assistantSession?.computer, clientIp: clientIp(req), outcome: 'error' });
    console.error('[assistant] search failed:', error.code || error.name || 'error');
    res.status(500).json({ success: false, error: 'ค้นหาผู้ป่วยไม่สำเร็จ ตรวจสอบ schema และสิทธิ์ฐานข้อมูล HOSxP', results: [] });
  }
});

router.get('/patient-vitals-history/:hn', async (req, res) => {
  const hn = String(req.params.hn || '');
  const vitalsType = String(req.query.type || '').toLowerCase();
  const filters = {
    bp: '(s.bps>0 OR s.bpd>0 OR s.pulse>0)',
    bw: '(s.bw>0 OR s.height>0 OR s.bmi>0)',
    temperature: 's.temperature>0',
    fbs: 's.fbs>0'
  };
  const valueFilter = filters[vitalsType] || '(s.bps>0 OR s.bpd>0 OR s.pulse>0 OR s.bw>0 OR s.height>0 OR s.bmi>0 OR s.temperature>0 OR s.fbs>0)';
  try {
    const [rows] = await getPool().execute(`SELECT DATE_FORMAT(o.vstdate,'%Y-%m-%d') AS vstdate,o.vsttime,s.bps,s.bpd,s.pulse,s.bw,s.height,s.bmi,s.temperature,s.fbs
      FROM opdscreen s JOIN ovst o ON o.vn=s.vn WHERE o.hn=?
        AND ${valueFilter}
      ORDER BY o.vstdate DESC,o.vsttime DESC LIMIT ${capLimit(req.query.limit)}`, [hn]);
    if (!audit(req, 'PATIENT_VITALS_HISTORY', { hn })) return res.status(503).json({ success: false, error: 'ระบบบันทึก audit ไม่พร้อม', data: [] });
    res.json({ success: true, hn, count: rows.length, data: rows.map(row => ({ ...row, vstdate_thai: thaiDate(row.vstdate) })) });
  } catch (error) { auditLog.record({ requestId: req.requestId, action: 'PATIENT_VITALS_HISTORY', actor: req.assistantSession?.user, workstation: req.assistantSession?.computer, clientIp: clientIp(req), resourceType: 'patient', resourceRef: hn, outcome: 'error' }); res.status(500).json({ success: false, error: 'อ่านประวัติสัญญาณชีพไม่สำเร็จ', data: [] }); }
});

router.get('/patient-lab-history/:hn', async (req, res) => {
  const hn = String(req.params.hn || '');
  const type = String(req.query.type || 'cr').toLowerCase().replace(/[^a-z0-9_ -]/g, '').trim();
  const matches = {
    cr: "(li.lab_items_name LIKE '%Creatinine%' OR li.lab_items_name LIKE '%eGFR%' OR li.lab_items_name LIKE '%ClCr%')",
    creatinine: "(li.lab_items_name LIKE '%Creatinine%' OR li.lab_items_name LIKE '%eGFR%' OR li.lab_items_name LIKE '%ClCr%')",
    hba1c: "(li.lab_items_name LIKE '%HbA1c%' OR li.lab_items_name LIKE '%A1C%')",
    fbs: "(li.lab_items_name LIKE '%FBS%' OR li.lab_items_name LIKE '%Glucose%' OR li.lab_items_name LIKE '%FPG%')",
    ldl: "(li.lab_items_name LIKE '%LDL%' OR li.lab_items_name LIKE '%Low density%')",
    hct: "(li.lab_items_name LIKE '%Hematocrit%' OR li.lab_items_name LIKE '%Hct%')",
    uacr: "(li.lab_items_name LIKE '%UACR%' OR li.lab_items_name LIKE '%Albumin Creatinine Ratio%' OR li.lab_items_name LIKE '%Urine ACR%')",
    k: "(li.lab_items_name LIKE '%Potassium%' OR li.lab_items_name='K' OR li.lab_items_name LIKE 'K (%')",
    na: "(li.lab_items_name LIKE '%Sodium%' OR li.lab_items_name='Na' OR li.lab_items_name LIKE 'Na (%')",
    bun: "li.lab_items_name LIKE '%BUN%'", uric: "li.lab_items_name LIKE '%Uric%'",
    ast: "(li.lab_items_name LIKE '%SGOT%' OR li.lab_items_name LIKE '%AST%')",
    alt: "(li.lab_items_name LIKE '%SGPT%' OR li.lab_items_name LIKE '%ALT%')",
    wbc: "(li.lab_items_name LIKE '%WBC%' OR li.lab_items_name LIKE '%White Blood%')",
    platelet: "(li.lab_items_name LIKE '%Platelet%' OR li.lab_items_name LIKE '%Plt%')"
  };
  const configuredCodes = getConfig()?.schema?.labTrendCodes?.[type];
  const codeList = Array.isArray(configuredCodes) ? configuredCodes.map(code => String(code).trim()).filter(code => /^[A-Za-z0-9._-]{1,30}$/.test(code)).slice(0, 20) : [];
  const where = codeList.length ? `lo.lab_items_code IN (${codeList.map(() => '?').join(',')})` : (matches[type] || 'li.lab_items_name LIKE ?');
  const params = [hn];
  if (codeList.length) params.push(...codeList);
  else if (!matches[type]) params.push(`%${type}%`);
  try {
    const [rows] = await getPool().execute(`SELECT DATE_FORMAT(lh.order_date,'%Y-%m-%d') AS order_date,lh.order_time,lo.lab_items_code,
      li.lab_items_name,li.lab_items_unit,lo.lab_order_result,lo.abnormal_result,lo.critical_result,
      IFNULL(lo.lab_items_normal_value_ref,li.lab_items_normal_value) AS lab_items_normal_value
      FROM lab_order lo JOIN lab_head lh ON lo.lab_order_number=lh.lab_order_number
      LEFT JOIN lab_items li ON li.lab_items_code=lo.lab_items_code WHERE lh.hn=? AND ${where}
      ORDER BY lh.order_date DESC,lh.order_time DESC LIMIT ${capLimit(req.query.limit)}`, params);
    if (!audit(req, 'PATIENT_LAB_HISTORY', { hn })) return res.status(503).json({ success: false, error: 'ระบบบันทึก audit ไม่พร้อม', data: [] });
    res.json({ success: true, hn, itemType: type, count: rows.length, data: rows.map(row => ({ ...row, order_date_thai: thaiDate(row.order_date) })) });
  } catch (error) { auditLog.record({ requestId: req.requestId, action: 'PATIENT_LAB_HISTORY', actor: req.assistantSession?.user, workstation: req.assistantSession?.computer, clientIp: clientIp(req), resourceType: 'patient', resourceRef: hn, outcome: 'error' }); res.status(500).json({ success: false, error: 'อ่านประวัติผลแล็บไม่สำเร็จ', data: [] }); }
});

router.get('/patient-visits/:hn', async (req, res) => {
  try {
    const [rows] = await getPool().execute(`SELECT o.vn,o.hn,DATE_FORMAT(o.vstdate,'%Y-%m-%d') AS vstdate,o.vsttime,
      IFNULL(k.department,'OPD') AS department_name,IFNULL(o.diag_text,'') AS diag_text,IFNULL(d.name,'') AS doctor_name,IFNULL(s.cc,'') AS cc
      FROM ovst o LEFT JOIN kskdepartment k ON o.main_dep=k.depcode LEFT JOIN doctor d ON o.doctor=d.code
      LEFT JOIN opdscreen s ON o.vn=s.vn WHERE o.hn=? ORDER BY o.vstdate DESC,o.vsttime DESC,o.vn DESC LIMIT ${capLimit(req.query.limit, 12)}`,
    [String(req.params.hn)]);
    if (!audit(req, 'PATIENT_VISIT_HISTORY', { hn: req.params.hn })) return res.status(503).json({ success: false, error: 'ระบบบันทึก audit ไม่พร้อม', visits: [] });
    res.json({ success: true, hn: req.params.hn, count: rows.length, visits: rows.map(row => ({ ...row, vstdate_thai: thaiDate(row.vstdate) })) });
  } catch (error) { auditLog.record({ requestId: req.requestId, action: 'PATIENT_VISIT_HISTORY', actor: req.assistantSession?.user, workstation: req.assistantSession?.computer, clientIp: clientIp(req), resourceType: 'patient', resourceRef: req.params.hn, outcome: 'error' }); res.status(500).json({ success: false, error: 'อ่านรายการ Visit ไม่สำเร็จ', visits: [] }); }
});

module.exports = router;
