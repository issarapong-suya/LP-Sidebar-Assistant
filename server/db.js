'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CONFIG_PATH = path.join(__dirname, 'config.json');
let pool = null;

function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return null; }
}

function getPool() {
  const config = getConfig();
  if (!config?.hosxp?.host || !config.hosxp.database || !config.hosxp.user) {
    throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล HOSxP');
  }
  if (!pool) {
    pool = mysql.createPool({
      host: config.hosxp.host,
      port: Number(config.hosxp.port) || 3306,
      database: config.hosxp.database,
      user: config.hosxp.user,
      password: config.hosxp.password || '',
      waitForConnections: true,
      connectionLimit: Math.min(Math.max(Number(config.hosxp.connectionLimit) || 10, 2), 30),
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: '+07:00'
    });
  }
  return pool;
}

async function testConnection(settings) {
  const connection = await mysql.createConnection({
    host: settings.host,
    port: Number(settings.port) || 3306,
    database: settings.database,
    user: settings.user,
    password: settings.password || '',
    connectTimeout: 7000,
    charset: 'utf8mb4',
    timezone: '+07:00'
  });
  try {
    await connection.query('SELECT 1');
    const [rows] = await connection.query('SELECT DATABASE() AS database_name');
    const [identityRows] = await connection.query('SELECT USER() AS connected_user, CURRENT_USER() AS authenticated_account');
    let activeRole = 'ตรวจสอบไม่ได้';
    try {
      const [roleRows] = await connection.query('SELECT CURRENT_ROLE() AS active_role');
      activeRole = String(roleRows[0]?.active_role || 'NONE');
    } catch (_) { /* CURRENT_ROLE is not available on every MySQL/MariaDB version. */ }
    const [grantRows] = await connection.query('SHOW GRANTS');
    const grants = grantRows.map(row => String(Object.values(row)[0] || ''));
    const grantCheck = inspectReadOnlyGrants(grants, settings.database);
    if (!grantCheck.readOnly) {
      const error = new Error(grantCheck.reason);
      error.grantCheck = { grants, ...grantCheck, identity: identityRows[0] || {}, activeRole };
      throw error;
    }
    // Probe only SELECT privileges on tables read unconditionally by the current Assistant API.
    // Optional deployments (opd_allergy/oapp) retain their API fallbacks and are not required here.
    for (const table of ['patient', 'ovst', 'doctor', 'kskdepartment', 'pttype', 'vn_stat', 'opdscreen', 'ovstdiag', 'icd101', 'opitemrece', 'drugitems', 'drugusage', 'lab_head', 'lab_order', 'lab_items', 'opduser']) {
      await connection.query(`SELECT 1 FROM \`${String(settings.database).replace(/`/g, '``')}\`.\`${table}\` LIMIT 0`);
    }
    return { success: true, database: rows[0]?.database_name || settings.database, readOnly: true, grants, identity: identityRows[0] || {}, activeRole };
  } finally {
    await connection.end();
  }
}

function inspectReadOnlyGrants(grants, targetDatabase = '') {
  if (!grants || !grants.length) return { readOnly: false, reason: 'ฐานข้อมูลไม่ส่งข้อมูลสิทธิ์ SHOW GRANTS กลับมา' };
  
  const targetDbClean = String(targetDatabase || '').replace(/[`']/g, '').trim().toLowerCase();
  const writePrivRegex = /\b(ALL(\s+PRIVILEGES)?|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|SUPER|GRANT|FILE)\b/i;
  const safePrivsRegex = /^(USAGE|SELECT(\s*,\s*SHOW\s+VIEW)?|SHOW\s+VIEW)$/i;

  for (const grant of grants) {
    const line = grant.trim();
    if (!line) continue;
    if (/\bWITH\s+GRANT\s+OPTION\b/i.test(line)) {
      return { readOnly: false, reason: 'บัญชีมี WITH GRANT OPTION ซึ่งเกินสิทธิ์อ่านอย่างเดียว' };
    }

    const match = line.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/i);
    if (!match) {
      // Role grants and nonstandard grant formats cannot be proven SELECT-only here.
      if (!/^GRANT\s+USAGE\s+ON\s+\*\.\*/i.test(line)) {
        return { readOnly: false, reason: 'พบสิทธิ์แบบ role หรือรูปแบบที่ระบบตรวจสอบ SELECT-only ไม่ได้' };
      }
      continue;
    }

    const privileges = match[1].trim();
    const rawScope = match[2].trim();
    const cleanScope = rawScope.replace(/[`']/g, '').replace(/\\_/g, '_');
    const grantee = match[3].replace(/[`']/g, '').trim();

    // 1. ข้ามสิทธิ์ของฐานข้อมูล test หรือ test\_% ที่ MariaDB/MySQL สร้างเป็นค่าเริ่มต้นและมอบให้ PUBLIC หรือ anonymous
    const scopeDb = cleanScope.split('.')[0].toLowerCase();
    const isTestDb = scopeDb === 'test' || scopeDb.startsWith('test_') || scopeDb === 'test%';
    if (isTestDb && targetDbClean !== 'test' && !targetDbClean.startsWith('test_')) {
      continue;
    }

    // 2. ข้าม USAGE ON *.*
    if (/^USAGE$/i.test(privileges) && cleanScope === '*.*') {
      continue;
    }

    // 3. ตรวจสอบระดับ Global (*.*) ต้องไม่มีสิทธิ์เขียน และต้องเป็นสิทธิ์อ่านอย่างเดียว
    if (cleanScope === '*.*') {
      if (writePrivRegex.test(privileges)) {
        return { readOnly: false, reason: `พบบัญชีสิทธิ์เขียนระดับ Global (*.*): ${privileges}` };
      }
      if (!safePrivsRegex.test(privileges)) {
        return { readOnly: false, reason: `พบบัญชีสิทธิ์ Global อื่นนอกจาก SELECT: ${privileges}` };
      }
      continue;
    }

    // 4. ตรวจสอบระดับฐานข้อมูล HOSxP เป้าหมาย (targetDatabase)
    const isTargetDb = !targetDbClean || scopeDb === targetDbClean;
    if (isTargetDb) {
      if (writePrivRegex.test(privileges)) {
        return { readOnly: false, reason: `พบบัญชีสิทธิ์เขียนบนฐานข้อมูล ${targetDatabase || cleanScope}: ${privileges}` };
      }
      if (!safePrivsRegex.test(privileges)) {
        return { readOnly: false, reason: `พบบัญชีสิทธิ์อื่นนอกจาก SELECT บนฐานข้อมูล ${targetDatabase || cleanScope}: ${privileges}` };
      }
      continue;
    }

    // 5. หากมีสิทธิ์บนฐานข้อมูลอื่น (Cross-database) ต้องไม่มีสิทธิ์เขียนเช่นกัน
    if (writePrivRegex.test(privileges)) {
      return { readOnly: false, reason: `พบบัญชีสิทธิ์เขียนบนฐานข้อมูล ${cleanScope}: ${privileges}` };
    }
  }

  return { readOnly: true, reason: '' };
}

async function closePool() {
  if (pool) {
    const active = pool;
    pool = null;
    await active.end();
  }
}

module.exports = { CONFIG_PATH, getConfig, getPool, testConnection, closePool, inspectReadOnlyGrants };
