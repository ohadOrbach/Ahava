// End-to-end scenario tests against the simulated WhatsApp transport.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TZ = "Asia/Jerusalem";
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ahava-")), "test.db");
delete process.env.ANTHROPIC_API_KEY;

const { migrate, all, one } = await import("../src/db.js");
const { seed } = await import("../src/seed.js");
const { tick } = await import("../src/scheduler.js");
const { handleInbound } = await import("../src/bot.js");
const clock = await import("../src/clock.js");

const MANAGER = "972520000001", MICHAL = "972520000006", DANI = "972520000021", NEW = "972529990001";
const advance = (min: number) => {
  const target = clock.now() + min * 60_000;
  while (clock.now() < target) { clock.setNow(Math.min(clock.now() + 15 * 60_000, target)); tick(); }
};
const msgs = (phone: string, sinceId = 0) => all<any>("SELECT * FROM messages WHERE phone=? AND id>? ORDER BY id", phone, sinceId);
const lastId = () => one<any>("SELECT MAX(id) m FROM messages")?.m ?? 0;
const send = async (phone: string, text: string) => { await handleInbound({ phone, text }); tick(); };
const press = async (phone: string, id: string) => { await handleInbound({ phone, button: { id, title: id } }); tick(); };
const lastButtons = (phone: string) => JSON.parse(msgs(phone).filter((m) => m.buttons).at(-1).buttons);

before(() => { migrate(); seed(); tick(); });

test("morning briefing: template nudge outside the 24h window, full text after tap", async () => {
  const start = lastId();
  advance(15); // 06:55 -> 07:10
  const nudge = msgs(MICHAL, start);
  assert.equal(nudge.length, 1);
  assert.equal(nudge[0].kind, "template");
  assert.equal(nudge[0].template, "daily_briefing");
  await press(MICHAL, "SHOW");
  const full = msgs(MICHAL, start).filter((m) => m.kind === "session");
  assert.match(full[0].body, /תדריך בוקר/);
  assert.match(full[0].body, /ארוחת צהריים ב-13:30/); // new item in full
  assert.match(full[0].body, /• 📅 ישיבת צוות חודשית/); // previously sent item as one line
});

test("no news, no briefing: a second tick the same day sends nothing", () => {
  const start = lastId();
  tick();
  assert.equal(msgs(MICHAL, start).length, 0);
});

test("manager writes free text, corrects it, publishes urgent+critical; read confirmation recorded", async () => {
  await send(MANAGER, "דחוף: מחר בבוקר אין הסעות. החניכים של גפן ורימון נשארים בפנימייה עד 10:00");
  const proposal = msgs(MANAGER).at(-1);
  assert.match(proposal.body, /הצעה לפרסום/);
  assert.match(proposal.body, /שינוי בלו״ז/);
  assert.match(proposal.body, /גפן, רימון/);
  await send(MANAGER, "רק לגפן, עם אישור קריאה");
  const corrected = msgs(MANAGER).at(-1).body;
  assert.match(corrected, /\*יעד:\* גפן \(/);
  assert.match(corrected, /אישור קריאה:\* ❗ כן/);
  const pub = lastButtons(MANAGER).find((b: any) => b.id.startsWith("PUB:")).id;
  const start = lastId();
  await press(MANAGER, pub);
  assert.match(msgs(MANAGER).at(-1).body, /נשלח עכשיו ל-\d+/);
  // Michal (Gefen) has an open window (she tapped earlier) -> gets it directly with a read button
  const m = msgs(MICHAL, start);
  assert.ok(m.some((x) => x.kind === "session" && /קראתי/.test(x.buttons ?? "")));
  // Dani is in Rimon today -> not relevant
  assert.equal(msgs(DANI, start).length, 0);
  const uid = Number(pub.split(":")[1]);
  await press(MICHAL, `READ:${uid}`);
  assert.ok(one("SELECT 1 FROM reads WHERE update_id=?", uid));
});

test("assignment by free text triggers a short briefing for the new unit, and switching back at noon", async () => {
  await send(MANAGER, "דני בגפן היום עד הצהריים");
  assert.match(msgs(MANAGER).at(-1).body, /דני אוחיון ← גפן/);
  const start = lastId();
  await press(MANAGER, "ASSIGNOK");
  const d = msgs(DANI, start);
  assert.ok(d.some((x) => x.template === "unit_switch" && /גפן/.test(x.body)));
  const s2 = lastId();
  advance(5 * 60); // past 12:00
  const log = all<any>("SELECT text FROM log").map((l) => l.text).join("\n");
  assert.match(log, /דני אוחיון עבר\/ה לרימון/);
  assert.ok(msgs(DANI, s2).length >= 1);
});

test("critical reminders go only to those who have not confirmed", () => {
  const crit = one<any>("SELECT id FROM updates WHERE title='נקודת כינוס חדשה בחירום'").id;
  const readers = all<any>("SELECT staff_id FROM reads WHERE update_id=?", crit).map((r) => r.staff_id);
  const reminded = all<any>("SELECT staff_id FROM reminders WHERE update_id=?", crit).map((r) => r.staff_id);
  assert.ok(reminded.length > 0);
  assert.ok(reminded.every((id) => !readers.includes(id)));
});

test("'מה עדכני?' returns the unit's active updates", async () => {
  await send(MICHAL, "מה עדכני?");
  assert.match(msgs(MICHAL).find((m) => /מה עדכני – גפן/.test(m.body))?.body ?? "", /מה עדכני – גפן/);
});

test("QR join: unknown number asks for name, manager approves, joiner gets procedures", async () => {
  await send(NEW, "זית – מה עדכני? (קוד ZYT-6643)");
  assert.match(msgs(NEW).at(-1).body, /מה השם המלא שלך/);
  await send(NEW, "ליאת מור");
  const req = msgs(MANAGER).filter((m) => /JOINOK/.test(m.buttons ?? "")).at(-1);
  const ok = JSON.parse(req.buttons).find((b: any) => b.id.startsWith("JOINOK")).id;
  const start = lastId();
  await press(MANAGER, ok);
  const got = msgs(NEW, start).map((m) => m.body).join("\n");
  assert.match(got, /ברוכים הבאים/);
  assert.match(got, /נוהל יציאה מהפנימייה/);
});

test("sensitive content about a child is flagged with a neutral rewrite", async () => {
  await send(MANAGER, "בטל");
  await send(MANAGER, "החניך יוסי מגפן צריך לקבל ריטלין ב-8 בבוקר");
  const p = msgs(MANAGER).at(-1);
  assert.match(p.body, /מידע רגיש/);
  assert.ok(JSON.parse(p.buttons).some((b: any) => b.id.startsWith("REWRITE:")));
  await send(MANAGER, "בטל");
});

test("temporary staff access ends automatically after the end date; expired updates drop out", () => {
  advance(24 * 60); // next day
  const ella = one<any>("SELECT status FROM staff WHERE name='אלה גולן'");
  assert.equal(ella.status, "ended");
  const { activeUpdates } = { activeUpdates: () => all<any>("SELECT * FROM updates WHERE status='active' AND (valid_until IS NULL OR valid_until > ?)", clock.now()) };
  assert.ok(!activeUpdates().some((u) => u.title === "ארוחת צהריים ב-13:30"));
});
