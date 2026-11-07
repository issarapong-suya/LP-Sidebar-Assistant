'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'audit.sqlite');
const FALLBACK_PATH = path.join(DATA_DIR, 'audit-fallback.jsonl');
const MAX_FALLBACK_READ_BYTES = 25 * 1024 * 1024;
fs.mkdirSync(DATA_DIR, { recursive: true });
const database = new DatabaseSync(DB_PATH);
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
database.exec(`CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  workstation TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_ref TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'success'
);
CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_at ON audit_events(actor, at);`);

let insertEventStmt = null;
function getInsertStmt() {
  if (!insertEventStmt) {
    insertEventStmt = database.prepare(`INSERT INTO audit_events
      (at, request_id, actor, workstation, client_ip, action, resource_type, resource_ref, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  }
  return insertEventStmt;
}

function safe(value, max = 120) {
  return String(value || '').replace(/[\r\n\0]/g, ' ').slice(0, max);
}

function patientReference(value) {
  if (!value) return '';
  const config = require('./db').getConfig() || {};
  const key = config.security?.auditHashKey || 'doctor-assistant-unconfigured';
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 24);
}

function record(event) {
  const row = {
    at: new Date().toISOString(),
    request_id: safe(event.requestId || crypto.randomUUID(), 80),
    actor: safe(event.actor, 100),
    workstation: safe(event.workstation, 100),
    client_ip: safe(event.clientIp, 64),
    action: safe(event.action, 80),
    resource_type: safe(event.resourceType, 40),
    resource_ref: patientReference(event.resourceRef),
    outcome: safe(event.outcome || 'success', 20)
  };
  try {
    let stmt = getInsertStmt();
    try {
      stmt.run(row.at, row.request_id, row.actor, row.workstation, row.client_ip,
        row.action, row.resource_type, row.resource_ref, row.outcome);
      return true;
    } catch (stmtErr) {
      if (String(stmtErr).includes('finalized')) {
        insertEventStmt = null;
        stmt = getInsertStmt();
        stmt.run(row.at, row.request_id, row.actor, row.workstation, row.client_ip,
          row.action, row.resource_type, row.resource_ref, row.outcome);
        return true;
      }
      throw stmtErr;
    }
  } catch (error) {
    // If SQLite is temporarily unavailable, preserve the audit event in a local append-only file.
    // Patient HN/VN has already been replaced by its HMAC reference above.
    try {
      fs.appendFileSync(FALLBACK_PATH, `${JSON.stringify(row)}${require('node:os').EOL}`, { encoding: 'utf8', flag: 'a' });
      console.error('[Audit] SQLite write failed; event stored in JSONL fallback:', error.code || error.name || 'error', error.message);
      return true;
    } catch (fallbackError) {
      console.error('[Audit] failed to persist event:', error.code || error.name || 'error', 'fallback:', fallbackError.code || fallbackError.name || 'error');
      return false;
    }
  }
}

function listEvents() {
  let sqliteEvents = [];
  let sqliteAvailable = true;
  try {
    const reader = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      sqliteEvents = reader.prepare(`SELECT at,request_id,actor,workstation,client_ip,action,resource_type,resource_ref,outcome
        FROM audit_events ORDER BY at DESC LIMIT 50000`).all().map(row => ({ ...row, source: 'sqlite' }));
    } finally {
      reader.close();
    }
  } catch (_) {
    sqliteAvailable = false;
  }

  let fallbackEvents = [];
  let fallbackAvailable = false;
  let fallbackTruncated = false;
  try {
    const stat = fs.statSync(FALLBACK_PATH);
    fallbackAvailable = true;
    let text;
    if (stat.size <= MAX_FALLBACK_READ_BYTES) {
      text = fs.readFileSync(FALLBACK_PATH, 'utf8');
    } else {
      fallbackTruncated = true;
      const fd = fs.openSync(FALLBACK_PATH, 'r');
      try {
        const buffer = Buffer.alloc(MAX_FALLBACK_READ_BYTES);
        fs.readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object' && typeof event.at === 'string' && typeof event.action === 'string') {
          fallbackEvents.push({ ...event, source: 'jsonl' });
        }
      } catch (_) { /* Skip incomplete/corrupt lines without blocking the viewer. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    events: [...sqliteEvents, ...fallbackEvents].sort((a, b) => String(b.at).localeCompare(String(a.at))),
    sqliteCount: sqliteEvents.length,
    sqliteAvailable,
    sqliteTruncated: sqliteEvents.length >= 50000,
    fallbackCount: fallbackEvents.length,
    fallbackAvailable,
    fallbackTruncated
  };
}

module.exports = { record, listEvents, DB_PATH, FALLBACK_PATH };
