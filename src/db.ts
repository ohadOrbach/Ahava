import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "ahava.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, code TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',      -- manager | staff
    kind TEXT NOT NULL DEFAULT 'fixed',      -- fixed | rotating | temp
    end_date TEXT,                           -- temp staff: last day of access
    status TEXT NOT NULL DEFAULT 'active',   -- active | pending | ended | rejected
    last_inbound_at INTEGER,                 -- opens the 24h WhatsApp window
    current_unit_id INTEGER,                 -- last observed unit, for mid-day switch detection
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY,
    staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,          -- fixed | weekday | oneoff
    weekday INTEGER,             -- weekday: 0=Sunday
    date TEXT,                   -- oneoff: YYYY-MM-DD
    start_time TEXT,             -- oneoff: HH:MM or null (start of day)
    end_time TEXT,               -- oneoff: HH:MM or null (end of day)
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY,
    author_id INTEGER,
    type TEXT NOT NULL,          -- procedure | event | schedule
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    target_all INTEGER NOT NULL DEFAULT 1,
    units TEXT NOT NULL DEFAULT '[]',   -- JSON array of unit ids
    urgent INTEGER NOT NULL DEFAULT 0,
    critical INTEGER NOT NULL DEFAULT 0,
    event_date TEXT,             -- event/schedule: YYYY-MM-DD
    event_time TEXT,             -- event: HH:MM or null
    valid_until INTEGER,         -- epoch ms, null = until replaced/cancelled
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | active | cancelled
    sensitive_note TEXT,
    suggested_rewrite TEXT,
    created_at INTEGER,
    published_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    update_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, delivered_at INTEGER,
    PRIMARY KEY (update_id, staff_id)
  );
  -- notified = told about it (template or full text); delivered = full text shown
  CREATE TABLE IF NOT EXISTS notified (
    update_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, at INTEGER,
    PRIMARY KEY (update_id, staff_id)
  );
  CREATE TABLE IF NOT EXISTS reads (
    update_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, read_at INTEGER,
    PRIMARY KEY (update_id, staff_id)
  );
  CREATE TABLE IF NOT EXISTS reminders (
    update_id INTEGER NOT NULL, staff_id INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_at INTEGER,
    PRIMARY KEY (update_id, staff_id)
  );
  -- idempotency keys for scheduled sends (briefing per person per day, reminders, ...)
  CREATE TABLE IF NOT EXISTS sent_keys (key TEXT PRIMARY KEY, at INTEGER);

  -- content waiting for the person to open the 24h window (tap on a template button)
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY, staff_id INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER
  );

  -- every WhatsApp message in/out (audit + simulator view)
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, phone TEXT NOT NULL, direction TEXT NOT NULL,
    kind TEXT NOT NULL,          -- template | session | inbound
    template TEXT, body TEXT NOT NULL, buttons TEXT, at INTEGER
  );

  CREATE TABLE IF NOT EXISTS conv (phone TEXT PRIMARY KEY, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, at INTEGER, text TEXT);
  CREATE TABLE IF NOT EXISTS login_codes (phone TEXT PRIMARY KEY, code TEXT, expires INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, staff_id INTEGER, expires INTEGER);
  `);
}

export function wipe() {
  db.exec(`
    DELETE FROM settings; DELETE FROM units; DELETE FROM staff; DELETE FROM assignments; DELETE FROM updates;
    DELETE FROM deliveries; DELETE FROM notified; DELETE FROM reads; DELETE FROM reminders; DELETE FROM sent_keys; DELETE FROM outbox;
    DELETE FROM messages; DELETE FROM conv; DELETE FROM log; DELETE FROM login_codes; DELETE FROM sessions;
  `);
}

export function one<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function getMeta(key: string): string | undefined {
  return one<{ value: string }>("SELECT value FROM meta WHERE key=?", key)?.value;
}
export function setMeta(key: string, value: string) {
  run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
}

// ---- Types ----
export interface Staff {
  id: number; name: string; phone: string; role: "manager" | "staff"; kind: "fixed" | "rotating" | "temp";
  end_date: string | null; status: string; last_inbound_at: number | null; current_unit_id: number | null; created_at: number;
}
export interface Unit { id: number; name: string; code: string }
export interface Update {
  id: number; author_id: number | null; type: "procedure" | "event" | "schedule"; title: string; body: string;
  target_all: number; units: string; urgent: number; critical: number; event_date: string | null; event_time: string | null;
  valid_until: number | null; status: string; sensitive_note: string | null; suggested_rewrite: string | null;
  created_at: number; published_at: number | null;
}

export const unitIds = (u: Update): number[] => JSON.parse(u.units || "[]");
