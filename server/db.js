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
    return { success: true, database: rows[0]?.database_name || settings.database };
  } finally {
    await connection.end();
  }
}

async function closePool() {
  if (pool) {
    const active = pool;
    pool = null;
    await active.end();
  }
}

module.exports = { CONFIG_PATH, getConfig, getPool, testConnection, closePool };
