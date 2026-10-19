import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS operations (
      key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
      result TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  }
  reserve(key, route, body) {
    if (typeof key !== 'string' || !/^[\w.-]{1,128}$/.test(key)) {
      throw new ApiError(400, 'idempotency_key_required', 'Provide an Idempotency-Key of 1–128 letters, digits, dots, underscores or hyphens.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical({route, body}))).digest('hex');
    const inserted = this.db.prepare('INSERT OR IGNORE INTO operations(key,fingerprint,state) VALUES(?,?,?)').run(key, fingerprint, 'in_progress');
    if (inserted.changes) return null;
    const row = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key);
    if (row.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'This key was already used for a different request.');
    if (!row.result) throw new ApiError(409, 'outcome_unknown', 'The prior attempt may still be running or its outcome is unknown. Inspect TikTok before creating a new key.');
    return JSON.parse(row.result);
  }
  finish(key, result) {
    this.db.prepare('UPDATE operations SET state=?,result=? WHERE key=?').run('finished', JSON.stringify(result), key);
  }
  close() { this.db.close(); }
}
