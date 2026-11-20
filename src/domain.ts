import { all, one, run, Staff, Unit, Update, unitIds } from "./db.js";
import { at, hm, now, today, weekdayOf, ymd, addDays, heDateTime, heRelDate } from "./clock.js";

// ---------------- Units ----------------
export const allUnits = () => all<Unit>("SELECT * FROM units ORDER BY id");
export const unitById = (id: number | null | undefined) => (id ? one<Unit>("SELECT * FROM units WHERE id=?", id) : undefined);
export const unitName = (id: number | null | undefined) => unitById(id)?.name ?? "";

// ---------------- Staff ----------------
export const staffByPhone = (phone: string) => one<Staff>("SELECT * FROM staff WHERE phone=?", phone);
export const staffById = (id: number) => one<Staff>("SELECT * FROM staff WHERE id=?", id);
export const activeStaff = () => all<Staff>("SELECT * FROM staff WHERE status='active' AND role='staff' ORDER BY name");
export const managers = () => all<Staff>("SELECT * FROM staff WHERE status='active' AND role='manager' ORDER BY id");
export const firstName = (s: Staff) => s.name.split(" ")[0];

/** Normalize Israeli phone input to E.164 digits without '+', e.g. 0521234567 -> 972521234567 */
export function normPhone(p: string): string {
  let d = p.replace(/\D/g, "");
  if (d.startsWith("0")) d = "972" + d.slice(1);
  return d;
}
export function displayPhone(p: string): string {
  if (p.startsWith("972")) {
    const l = "0" + p.slice(3);
    return l.length === 10 ? `${l.slice(0, 3)}-${l.slice(3)}` : l;
  }
  return p;
}

// ---------------- Assignments ----------------
interface Assignment {
  id: number; staff_id: number; unit_id: number; kind: "fixed" | "weekday" | "oneoff";
  weekday: number | null; date: string | null; start_time: string | null; end_time: string | null; created_at: number;
}

function baseAssignment(staffId: number, date: string): Assignment | undefined {
  const wd = weekdayOf(date);
  return (
    one<Assignment>("SELECT * FROM assignments WHERE staff_id=? AND kind='weekday' AND weekday=? ORDER BY id DESC", staffId, wd) ??
    one<Assignment>("SELECT * FROM assignments WHERE staff_id=? AND kind='fixed' ORDER BY id DESC", staffId)
  );
}
function oneoffs(staffId: number, date: string): Assignment[] {
  return all<Assignment>("SELECT * FROM assignments WHERE staff_id=? AND kind='oneoff' AND date=? ORDER BY id", staffId, date);
}
const covers = (a: Assignment, time: string) => (a.start_time ?? "00:00") <= time && time < (a.end_time ?? "24:00");

/** The unit a person works in at a given moment (one-off changes override weekday/fixed). */
export function unitAt(staffId: number, ms = now()): number | null {
  const date = ymd(ms), time = hm(ms);
  const o = oneoffs(staffId, date).reverse().find((a) => covers(a, time));
  if (o) return o.unit_id;
  return baseAssignment(staffId, date)?.unit_id ?? null;
}

export interface Segment { unit_id: number; from: string; to: string }
/** Timeline of units for the day, e.g. [{Gefen 00:00-12:00}, {Rimon 12:00-24:00}] */
export function dayTimeline(staffId: number, date: string): Segment[] {
  const points = new Set<string>(["00:00"]);
  for (const a of oneoffs(staffId, date)) {
    if (a.start_time) points.add(a.start_time);
    if (a.end_time) points.add(a.end_time);
  }
  const sorted = [...points].sort();
  const segs: Segment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i], to = sorted[i + 1] ?? "24:00";
    const u = unitAt(staffId, at(date, from));
    if (u == null) continue;
    const last = segs[segs.length - 1];
    if (last && last.unit_id === u) last.to = to;
    else segs.push({ unit_id: u, from, to });
  }
  return segs;
}
export const unitsOnDay = (staffId: number, date: string) => [...new Set(dayTimeline(staffId, date).map((s) => s.unit_id))];

export function addAssignment(a: Omit<Assignment, "id" | "created_at">) {
  if (a.kind === "fixed") run("DELETE FROM assignments WHERE staff_id=? AND kind='fixed'", a.staff_id);
  if (a.kind === "weekday") run("DELETE FROM assignments WHERE staff_id=? AND kind='weekday' AND weekday=?", a.staff_id, a.weekday);
  run(
    "INSERT INTO assignments(staff_id,unit_id,kind,weekday,date,start_time,end_time,created_at) VALUES(?,?,?,?,?,?,?,?)",
    a.staff_id, a.unit_id, a.kind, a.weekday, a.date, a.start_time, a.end_time, now()
  );
}

// ---------------- Updates ----------------
/** When an update stops being shown. Procedures: never (until replaced/cancelled). */
export function computeValidUntil(u: Pick<Update, "type" | "event_date" | "event_time">): number | null {
  if (u.type === "procedure" || !u.event_date) return null;
  if (u.type === "event" && u.event_time) return at(u.event_date, u.event_time) + 60 * 60 * 1000;
  return at(addDays(u.event_date, 1), "00:00");
}

export function activeUpdates(ms = now()): Update[] {
  return all<Update>(
    "SELECT * FROM updates WHERE status='active' AND (valid_until IS NULL OR valid_until > ?) ORDER BY published_at",
    ms
  );
}
export const updateById = (id: number) => one<Update>("SELECT * FROM updates WHERE id=?", id);

export function isRelevant(u: Update, units: number[]): boolean {
  if (u.target_all) return true;
  const ids = unitIds(u);
  return units.some((x) => ids.includes(x));
}
/** Active updates relevant to the given units. */
export function relevantUpdates(units: number[], ms = now()): Update[] {
  return activeUpdates(ms).filter((u) => isRelevant(u, units));
}
/** Staff relevant to an update on a given day (anyone working in a target unit at any point that day). */
export function staffForUpdate(u: Update, date = today()): Staff[] {
  return activeStaff().filter((s) => u.target_all || isRelevant(u, unitsOnDay(s.id, date)));
}

export const isDelivered = (uid: number, sid: number) => !!one("SELECT 1 FROM deliveries WHERE update_id=? AND staff_id=?", uid, sid);
export const isRead = (uid: number, sid: number) => !!one("SELECT 1 FROM reads WHERE update_id=? AND staff_id=?", uid, sid);
export function markDelivered(uid: number, sid: number) {
  run("INSERT OR IGNORE INTO deliveries(update_id,staff_id,delivered_at) VALUES(?,?,?)", uid, sid, now());
  markNotified(uid, sid);
}
export function markNotified(uid: number, sid: number) {
  run("INSERT OR IGNORE INTO notified(update_id,staff_id,at) VALUES(?,?,?)", uid, sid, now());
}
export function markRead(uid: number, sid: number) {
  run("INSERT OR IGNORE INTO reads(update_id,staff_id,read_at) VALUES(?,?,?)", uid, sid, now());
}

export function targetLabel(u: Update): string {
  if (u.target_all) return "כל הצוות";
  return unitIds(u).map(unitName).filter(Boolean).join(", ");
}

export function log(text: string) {
  run("INSERT INTO log(at,text) VALUES(?,?)", now(), text);
}

/** Idempotency: returns true the first time a key is claimed. */
export function claim(key: string): boolean {
  const r = run("INSERT OR IGNORE INTO sent_keys(key,at) VALUES(?,?)", key, now());
  return Number(r.changes) > 0;
}
export const claimed = (key: string) => !!one("SELECT 1 FROM sent_keys WHERE key=?", key);

/** "עד סוף היום" / "עד מחר 15:00" / "עד שיוחלף" */
export function validityLabel(u: Pick<Update, "type" | "valid_until">): string {
  if (u.type === "procedure" || !u.valid_until) return "עד שיוחלף או יבוטל";
  if (hm(u.valid_until) === "00:00") return `עד סוף ${heRelDate(ymd(u.valid_until - 1))}`;
  return `עד ${heDateTime(u.valid_until)}`;
}
