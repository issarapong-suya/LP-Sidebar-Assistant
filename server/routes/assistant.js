'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getPool, getConfig } = require('../db');
const router = express.Router();
const activePatients = new Map();
const AUDIT_PATH = path.join(__dirname, '..', 'data', 'access.jsonl');

function clientIp(req) {
  let ip = String(req.ip || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function audit(req, action, patient = {}) {
  const record = {
    at: new Date().toISOString(), action, hn: String(patient.hn || ''),
    vn: String(patient.vn || ''), ip: clientIp(req), computer: String(req.query.computer || '')
  };
  fs.appendFile(AUDIT_PATH, `${JSON.stringify(record)}\n`, () => {});
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
  return Math.min(Math.max(parseInt(value, 10) || fallback, 1), 50);
}

function egfr2021(creatinine, age, sex) {
  const cr = Number(creatinine), years = Number(age);
  if (!(cr > 0) || !(years > 0)) return null;
  const female = String(sex) === '2' || String(sex).toLowerCase() === 'female';
  const k = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  return 142 * Math.pow(Math.min(cr / k, 1), alpha) * Math.pow(Math.max(cr / k, 1), -1.2) * Math.pow(0.9938, years) * (female ? 1.012 : 1);
}

router.get('/sync-patient', (req, res) => {
  const ip = clientIp(req);
  const state = activePatients.get(ip) || (ip === '127.0.0.1' ? activePatients.get('127.0.0.1') : null);
  const alive = state && Date.now() - state.timestamp < 25000;
  res.json({
    vn: alive ? state.vn || null : null,
    hn: alive ? state.hn || null : null,
    user: alive ? state.user || '' : '',
    live_diag: alive ? state.live_diag || '' : '',
    last_click_id: state?.last_click_id || 0,
    last_click_vn: state?.last_click_vn || '',
    isLive: !!alive,
    timestamp: Date.now()
  });
});

router.post('/notify-patient', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  const ip = clientIp(req);
  const previous = activePatients.get(ip) || {};
  const isClick = body.trigger === 'click' || body.click_id;
  const state = {
    vn: String(body.vn || ''), hn: String(body.hn || ''), user: String(body.user || ''),
    live_diag: String(body.live_diag || previous.live_diag || ''),
    last_click_id: Number(body.click_id) || (isClick ? Date.now() : previous.last_click_id || 0),
    last_click_vn: isClick ? String(body.vn || '') : previous.last_click_vn || '',
    timestamp: Date.now()
  };
  activePatients.set(ip, state);
  if (ip === '127.0.0.1') activePatients.set('127.0.0.1', state);
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
    const payload = {
      success: true,
      visit: { ...visit, vstdate_thai: thaiDateFull(visit.vstdate), appointment, is_on_warfarin: /warfarin/i.test(`${patient.drugallergy || ''} ${screening.pmh || ''} ${medications.map(m => m.name).join(' ')}`) },
      patient: { ...patient, hn: visit.hn, age, age_y: age, age_text: age ? `${age} ปี ${stats[0]?.age_m ? `${stats[0].age_m} เดือน` : ''}`.trim() : '', sex: String(patient.sex) === '1' ? 'ชาย' : String(patient.sex) === '2' ? 'หญิง' : 'ไม่ระบุ' },
      screening: { ...screening, cr: creatinine ? creatinine.toFixed(2) : '0', egfr: egfr ? egfr.toFixed(1) : '0', crcl: crcl ? crcl.toFixed(1) : '', stage: egfr >= 90 ? '1' : egfr >= 60 ? '2' : egfr >= 30 ? '3' : egfr >= 15 ? '4' : egfr ? '5' : '-' },
      diagnoses: diagnosesOut, medications, labResults
    };
    audit(req, 'ASSISTANT_VISIT', { hn: visit.hn, vn });
    res.json(payload);
  } catch (error) {
    console.error('[assistant] visit-data:', error.message);
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
    audit(req, 'ASSISTANT_SEARCH');
    res.json({ success: true, total: rows.length, patient: rows[0] || null, vn: rows[0]?.vn || null, results: rows.map(row => ({ ...row, vstdate_formatted: row.vstdate || '' })) });
  } catch (error) {
    console.error('[assistant] search:', error.message);
    res.status(500).json({ success: false, error: 'ค้นหาผู้ป่วยไม่สำเร็จ ตรวจสอบ schema และสิทธิ์ฐานข้อมูล HOSxP', results: [] });
  }
});

router.get('/patient-vitals-history/:hn', async (req, res) => {
  const hn = String(req.params.hn || '');
  try {
    const [rows] = await getPool().execute(`SELECT DATE_FORMAT(o.vstdate,'%Y-%m-%d') AS vstdate,o.vsttime,s.bps,s.bpd,s.pulse,s.bw,s.height,s.bmi,s.temperature,s.fbs
      FROM opdscreen s JOIN ovst o ON o.vn=s.vn WHERE o.hn=? AND (s.bps>0 OR s.bpd>0 OR s.pulse>0)
      ORDER BY o.vstdate DESC,o.vsttime DESC LIMIT ${capLimit(req.query.limit)}`, [hn]);
    res.json({ success: true, hn, count: rows.length, data: rows.map(row => ({ ...row, vstdate_thai: thaiDate(row.vstdate) })) });
  } catch (error) { res.status(500).json({ success: false, error: 'อ่านประวัติสัญญาณชีพไม่สำเร็จ', data: [] }); }
});

router.get('/patient-lab-history/:hn', async (req, res) => {
  const hn = String(req.params.hn || '');
  const type = String(req.query.type || 'cr').toLowerCase().replace(/[^a-z0-9_ -]/g, '').trim();
  const matches = {
    cr: "(li.lab_items_name LIKE '%Creatinine%' OR li.lab_items_name LIKE '%eGFR%' OR li.lab_items_name LIKE '%ClCr%')",
    creatinine: "(li.lab_items_name LIKE '%Creatinine%' OR li.lab_items_name LIKE '%eGFR%' OR li.lab_items_name LIKE '%ClCr%')",
    hba1c: "(li.lab_items_name LIKE '%HbA1c%' OR li.lab_items_name LIKE '%A1C%')",
    fbs: "(li.lab_items_name LIKE '%FBS%' OR li.lab_items_name LIKE '%Glucose%' OR li.lab_items_name LIKE '%FPG%')",
    k: "(li.lab_items_name LIKE '%Potassium%' OR li.lab_items_name='K' OR li.lab_items_name LIKE 'K (%')",
    na: "(li.lab_items_name LIKE '%Sodium%' OR li.lab_items_name='Na' OR li.lab_items_name LIKE 'Na (%')",
    bun: "li.lab_items_name LIKE '%BUN%'", uric: "li.lab_items_name LIKE '%Uric%'",
    ast: "(li.lab_items_name LIKE '%SGOT%' OR li.lab_items_name LIKE '%AST%')",
    alt: "(li.lab_items_name LIKE '%SGPT%' OR li.lab_items_name LIKE '%ALT%')",
    wbc: "(li.lab_items_name LIKE '%WBC%' OR li.lab_items_name LIKE '%White Blood%')",
    platelet: "li.lab_items_name LIKE '%Platelet%'"
  };
  const where = matches[type] || 'li.lab_items_name LIKE ?';
  const params = [hn];
  if (!matches[type]) params.push(`%${type}%`);
  try {
    const [rows] = await getPool().execute(`SELECT DATE_FORMAT(lh.order_date,'%Y-%m-%d') AS order_date,lh.order_time,lo.lab_items_code,
      li.lab_items_name,li.lab_items_unit,lo.lab_order_result,lo.abnormal_result,lo.critical_result,
      IFNULL(lo.lab_items_normal_value_ref,li.lab_items_normal_value) AS lab_items_normal_value
      FROM lab_order lo JOIN lab_head lh ON lo.lab_order_number=lh.lab_order_number
      LEFT JOIN lab_items li ON li.lab_items_code=lo.lab_items_code WHERE lh.hn=? AND ${where}
      ORDER BY lh.order_date DESC,lh.order_time DESC LIMIT ${capLimit(req.query.limit)}`, params);
    res.json({ success: true, hn, itemType: type, count: rows.length, data: rows.map(row => ({ ...row, order_date_thai: thaiDate(row.order_date) })) });
  } catch (error) { res.status(500).json({ success: false, error: 'อ่านประวัติผลแล็บไม่สำเร็จ', data: [] }); }
});

router.get('/patient-visits/:hn', async (req, res) => {
  try {
    const [rows] = await getPool().execute(`SELECT o.vn,o.hn,DATE_FORMAT(o.vstdate,'%Y-%m-%d') AS vstdate,o.vsttime,
      IFNULL(k.department,'OPD') AS department_name,IFNULL(o.diag_text,'') AS diag_text,IFNULL(d.name,'') AS doctor_name,IFNULL(s.cc,'') AS cc
      FROM ovst o LEFT JOIN kskdepartment k ON o.main_dep=k.depcode LEFT JOIN doctor d ON o.doctor=d.code
      LEFT JOIN opdscreen s ON o.vn=s.vn WHERE o.hn=? ORDER BY o.vstdate DESC,o.vsttime DESC,o.vn DESC LIMIT ${capLimit(req.query.limit, 12)}`,
    [String(req.params.hn)]);
    res.json({ success: true, hn: req.params.hn, count: rows.length, visits: rows.map(row => ({ ...row, vstdate_thai: thaiDate(row.vstdate) })) });
  } catch (error) { res.status(500).json({ success: false, error: 'อ่านรายการ Visit ไม่สำเร็จ', visits: [] }); }
});

module.exports = router;
