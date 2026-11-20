// Inbound WhatsApp message handling: managers author updates and assignments; staff only receive and ask.

import { all, one, run, Staff, Update, unitIds } from "./db.js";
import { addDays, at, heDate, heDateTime, HE_DAYS, hm, now, today } from "./clock.js";
import {
  addAssignment, allUnits, claim, computeValidUntil, displayPhone, firstName, isRead, log, managers, markRead,
  normPhone, staffByPhone, staffById, staffForUpdate, targetLabel, unitAt, unitById, unitName, updateById, activeStaff, validityLabel,
} from "./domain.js";
import { logInbound, sendSession, sendTemplate, Button } from "./whatsapp.js";
import { deliver, flushOutbox, sendNow, windowOpen } from "./messenger.js";
import { helpText, renderProcedures, renderWhatsNew, typeName } from "./render.js";
import { AddStaffDraft, AssignmentDraft, correctDraft, isCommandLike, parseManagerText, UpdateDraft } from "./parser.js";
import { getNum, getSetting } from "./settings.js";
import { tick } from "./scheduler.js";

type Conv =
  | { mode: "draft"; draftId: number }
  | { mode: "assign"; a: AssignmentDraft }
  | { mode: "addstaff"; s: AddStaffDraft }
  | { mode: "join_name"; unitId: number | null };

const getConv = (phone: string): Conv | null => {
  const r = one<{ state: string }>("SELECT state FROM conv WHERE phone=?", phone);
  return r ? JSON.parse(r.state) : null;
};
const setConv = (phone: string, c: Conv | null) => {
  if (!c) run("DELETE FROM conv WHERE phone=?", phone);
  else run("INSERT INTO conv(phone,state) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET state=excluded.state", phone, JSON.stringify(c));
};

const reply = (phone: string, text: string, buttons?: Button[]) => sendSession(phone, text, buttons);
const norm = (t: string) => t.replace(/[?!.,״"']/g, "").replace(/\s+/g, " ").trim();
const CODE_RE = /\b([A-Z]{3}-\d{4})\b/;

export interface Inbound { phone: string; text?: string; button?: { id: string; title: string } }

export async function handleInbound(msg: Inbound) {
  const phone = normPhone(msg.phone);
  logInbound(phone, msg.button ? `[${msg.button.title}]` : msg.text ?? "");
  const s = staffByPhone(phone);
  if (!s || s.status !== "active") return handleUnknown(phone, s, msg);

  run("UPDATE staff SET last_inbound_at=? WHERE id=?", now(), s.id);
  s.last_inbound_at = now();
  const flushed = flushOutbox(s);

  if (msg.button) return handleButton(s, msg.button.id, flushed);
  const text = (msg.text ?? "").trim();
  if (!text) return;
  const n = norm(text);

  // QR code on a unit door (works for anyone registered)
  const code = text.match(CODE_RE)?.[1];
  const qrUnit = code ? allUnits().find((u) => u.code === code) : undefined;
  if (qrUnit) {
    sendNow(s, renderWhatsNew(s, qrUnit.id));
    reply(phone, `נמצא/ת עכשיו ב${qrUnit.name}?`, [{ id: `HERE:${qrUnit.id}`, title: "📍 אני כאן עכשיו" }]);
    return;
  }
  if (/^(מה עדכני|מה חדש|עדכונים|מה העדכונים|תדריך)$/.test(n)) {
    if (!flushed) sendNow(s, renderWhatsNew(s));
    return;
  }
  if (/^(נהלים|מה הנהלים|רשימת נהלים)$/.test(n)) return sendNow(s, renderProcedures(s));
  if (/^(עזרה|help|תפריט)$/i.test(n)) return reply(phone, helpText(s.role === "manager"));

  if (s.role === "manager") return handleManagerText(s, text, n);
  if (!flushed) reply(phone, helpText(false));
}

// ------------------------------------------------------------------ unknown / pending numbers
function handleUnknown(phone: string, s: Staff | undefined, msg: Inbound) {
  if (s?.status === "pending") return reply(phone, "הבקשה שלך ממתינה לאישור ההנהלה. נעדכן כאן ברגע שתאושר 🙏");
  const conv = getConv(phone);
  const text = (msg.text ?? "").trim();
  if (conv?.mode === "join_name" && text && !CODE_RE.test(text)) {
    const name = text.replace(/^(שמי|השם שלי|אני)\s+/, "").slice(0, 40);
    const end = addDays(today(), getNum("temp_default_days"));
    let id: number;
    if (s) {
      run("UPDATE staff SET name=?, status='pending', kind='temp', end_date=? WHERE id=?", name, end, s.id);
      id = s.id;
    } else {
      id = Number(run("INSERT INTO staff(name,phone,role,kind,end_date,status,last_inbound_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
        name, phone, "staff", "temp", end, "pending", now(), now()).lastInsertRowid);
    }
    if (conv.unitId) addAssignment({ staff_id: id, unit_id: conv.unitId, kind: "fixed", weekday: null, date: null, start_time: null, end_time: null });
    setConv(phone, null);
    const unitTxt = conv.unitId ? ` – סרק/ה QR של ${unitName(conv.unitId)}` : "";
    for (const m of managers()) {
      if (windowOpen(m)) reply(m.phone, `🙋 *בקשת הצטרפות*: ${name} (${displayPhone(phone)})${unitTxt}\nגישה זמנית עד ${heDate(end)}.`, [
        { id: `JOINOK:${id}`, title: "✅ אשר" }, { id: `JOINNO:${id}`, title: "❌ דחה" },
      ]);
      else sendTemplate(m.phone, "join_request", [name, displayPhone(phone), unitTxt], [`JOINOK:${id}`, `JOINNO:${id}`]);
    }
    log(`בקשת הצטרפות: ${name} (${displayPhone(phone)})`);
    return reply(phone, `תודה ${name.split(" ")[0]}! 🙏 הבקשה נשלחה להנהלה. ברגע שתאושר, יגיעו לכאן הנהלים והעדכונים הרלוונטיים.`);
  }
  const code = text.match(CODE_RE)?.[1];
  const unit = code ? allUnits().find((u) => u.code === code) : undefined;
  setConv(phone, { mode: "join_name", unitId: unit?.id ?? null });
  return reply(phone, `שלום! 👋 זה הבוט של עדכוני הצוות ב${getSetting("school_name")}.\nהמספר הזה עדיין לא רשום.\n\nכדי לבקש הצטרפות, מה השם המלא שלך?`);
}

// ------------------------------------------------------------------ buttons
async function handleButton(s: Staff, id: string, flushed: boolean) {
  const [cmd, arg] = id.split(":");
  const n = Number(arg);
  switch (cmd) {
    case "SHOW":
      if (!flushed) sendNow(s, renderWhatsNew(s));
      return;
    case "START":
      return;
    case "READ": {
      const u = updateById(n);
      if (!u) return;
      if (!isRead(n, s.id)) {
        markRead(n, s.id);
        log(`${s.name} אישר/ה קריאה: ${u.title}`);
      }
      return reply(s.phone, `✔ תודה ${firstName(s)}, נרשם שקראת את "${u.title}".`);
    }
    case "HERE": {
      addAssignment({ staff_id: s.id, unit_id: n, kind: "oneoff", weekday: null, date: today(), start_time: hm(now()), end_time: null });
      run("UPDATE staff SET current_unit_id=? WHERE id=?", n, s.id);
      log(`${s.name} עדכן/ה מיקום דרך QR: ${unitName(n)}`);
      return reply(s.phone, `✔ עודכן: את/ה ב${unitName(n)} מעכשיו ועד סוף היום.`);
    }
  }
  if (s.role !== "manager") return;
  switch (cmd) {
    case "PUB": return publish(s, n);
    case "SENDNOW": return sendNowToAll(s, n);
    case "EDIT": return reply(s.phone, `✏️ מה לתקן? כתבו בחופשיות, למשל:\n• "רק לגפן ורימון"\n• "לא דחוף" / "דחוף"\n• "עם אישור קריאה"\n• "מחר ב-17:00"\n• "כותרת: ..." או "תוכן: ..."`);
    case "REWRITE": {
      const u = updateById(n);
      if (!u || u.status !== "draft" || !u.suggested_rewrite) return;
      const title = u.suggested_rewrite.split(/[–.\n]/)[0].trim().slice(0, 60);
      run("UPDATE updates SET title=?, body=?, sensitive_note=NULL, suggested_rewrite=NULL WHERE id=?", title, u.suggested_rewrite, n);
      return showProposal(s, n);
    }
    case "DISCARD": {
      run("DELETE FROM updates WHERE id=? AND status='draft'", n);
      setConv(s.phone, null);
      return reply(s.phone, "🗑 הטיוטה נמחקה. לא נשלח כלום.");
    }
    case "ASSIGNOK": {
      const c = getConv(s.phone);
      if (c?.mode !== "assign") return;
      addAssignment(c.a);
      setConv(s.phone, null);
      const p = staffById(c.a.staff_id)!;
      log(`שיבוץ: ${p.name} ← ${unitName(c.a.unit_id)} (${s.name})`);
      reply(s.phone, `✔ נשמר. ${firstName(p)} יקבל/תקבל עדכון ליחידה בזמן המעבר.`);
      tick();
      return;
    }
    case "ASSIGNNO":
    case "ADDNO":
      setConv(s.phone, null);
      return reply(s.phone, "בוטל ✔");
    case "ADDOK": {
      const c = getConv(s.phone);
      if (c?.mode !== "addstaff") return;
      setConv(s.phone, null);
      return addTempStaff(s, c.s);
    }
    case "JOINOK":
    case "JOINNO": {
      const p = staffById(n);
      if (!p || p.status !== "pending") return reply(s.phone, "הבקשה כבר טופלה ✔");
      if (cmd === "JOINNO") {
        run("UPDATE staff SET status='rejected' WHERE id=?", n);
        log(`בקשת הצטרפות נדחתה: ${p.name}`);
        return reply(s.phone, `❌ הבקשה של ${p.name} נדחתה.`);
      }
      run("UPDATE staff SET status='active' WHERE id=?", n);
      log(`בקשת הצטרפות אושרה: ${p.name} (${s.name})`);
      reply(s.phone, `✅ ${p.name} אושר/ה וקיבל/ה את הנהלים והעדכונים. גישה עד ${heDate(p.end_date!)} (אפשר לשנות במסך הניהול).`);
      welcome(staffById(n)!);
      return;
    }
  }
}

function welcome(p: Staff) {
  claim(`briefing:${p.id}:${today()}`); // the onboarding pack already includes today's briefing
  deliver(p, { type: "onboarding" }, { name: "welcome", params: [firstName(p), getSetting("school_name")] });
}

// ------------------------------------------------------------------ manager free text
async function handleManagerText(s: Staff, text: string, n: string) {
  const conv = getConv(s.phone);

  if (/^(עדכונים פעילים|רשימה|רשימת עדכונים)$/.test(n)) return reply(s.phone, activeList());
  if (/^(שיבוצים|מי איפה|מי איפה היום)$/.test(n)) return reply(s.phone, assignmentsToday());
  const cancel = n.match(/^(?:בטל|ביטול|מחק)\s+(?:עדכון\s+)?#?(\d+)$/);
  if (cancel) return cancelUpdate(s, Number(cancel[1]));
  if (/^(בטל|ביטול)$/.test(n) && conv) {
    if (conv.mode === "draft") run("DELETE FROM updates WHERE id=? AND status='draft'", conv.draftId);
    setConv(s.phone, null);
    return reply(s.phone, "בוטל ✔ לא נשלח כלום.");
  }

  // a pending draft: a short reply (or one that reads like a correction) edits it; a long new message starts a new draft
  let note = "";
  if (conv?.mode === "draft") {
    const u = updateById(conv.draftId);
    const looksLikeCorrection = !isCommandLike(text) &&
      (text.split(/\s+/).length <= 8 || /^(רק|לא |גם|עם|בלי|ללא|כותרת|תוכן|נוסח|סוג|שנה|תקן|תקני|בעצם|תיקון)/.test(text));
    if (u?.status === "draft" && !looksLikeCorrection) {
      run("DELETE FROM updates WHERE id=? AND status='draft'", u.id);
      setConv(s.phone, null);
      note = `(הטיוטה הקודמת "${u.title}" לא פורסמה ונמחקה)\n\n`;
    } else if (u?.status === "draft") {
      const corrected = await correctDraft(rowToDraft(u), text);
      if (!corrected) return reply(s.phone, `לא הבנתי את התיקון 🤔\nאפשר לכתוב למשל "רק לגפן", "לא דחוף", "עם אישור קריאה", "מחר ב-17:00", או ללחוץ "בטל".`);
      saveDraft(corrected, s.id, conv.draftId);
      return showProposal(s, conv.draftId);
    }
  }

  const r = await parseManagerText(text);
  if (r.intent === "update") {
    const id = saveDraft(r.update, s.id);
    setConv(s.phone, { mode: "draft", draftId: id });
    return showProposal(s, id, note);
  }
  if (r.intent === "assignment") {
    setConv(s.phone, { mode: "assign", a: r.assignment });
    return reply(s.phone, `🧭 *שיבוץ*\n${describeAssignment(r.assignment)}\n\nלאשר?`, [
      { id: "ASSIGNOK", title: "✅ אשר" }, { id: "ASSIGNNO", title: "🗑 בטל" },
    ]);
  }
  if (r.intent === "add_staff") {
    const d = { ...r.staff, end_date: r.staff.end_date || addDays(today(), getNum("temp_default_days")) };
    setConv(s.phone, { mode: "addstaff", s: d });
    return reply(s.phone, `➕ *הוספת עובד/ת זמני/ת*\nשם: ${d.name}\nטלפון: ${displayPhone(normPhone(d.phone))}\nיחידה: ${d.unit_id ? unitName(d.unit_id) : "לא צוין (רק עדכונים לכל הצוות)"}\nגישה עד: ${heDate(d.end_date)}\n\nלאשר? תישלח הודעת פתיחה עם הנהלים והתדריך הנוכחי.`, [
      { id: "ADDOK", title: "✅ אשר" }, { id: "ADDNO", title: "🗑 בטל" },
    ]);
  }
  return reply(s.phone, helpText(true));
}

function rowToDraft(u: Update): UpdateDraft {
  return {
    type: u.type, title: u.title, body: u.body, target_all: !!u.target_all, units: unitIds(u), urgent: !!u.urgent, critical: !!u.critical,
    event_date: u.event_date, event_time: u.event_time, sensitive_note: u.sensitive_note, suggested_rewrite: u.suggested_rewrite,
  };
}

function saveDraft(d: UpdateDraft, authorId: number, id?: number): number {
  const vals = [
    d.type, d.title, d.body, d.target_all ? 1 : 0, JSON.stringify(d.target_all ? [] : d.units), d.urgent ? 1 : 0, d.critical ? 1 : 0,
    d.event_date, d.event_time, computeValidUntil(d), d.sensitive_note, d.suggested_rewrite,
  ];
  if (id) {
    run(`UPDATE updates SET type=?,title=?,body=?,target_all=?,units=?,urgent=?,critical=?,event_date=?,event_time=?,valid_until=?,sensitive_note=?,suggested_rewrite=? WHERE id=?`, ...vals, id);
    return id;
  }
  return Number(run(`INSERT INTO updates(type,title,body,target_all,units,urgent,critical,event_date,event_time,valid_until,sensitive_note,suggested_rewrite,author_id,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`, ...vals, authorId, now()).lastInsertRowid);
}

function validityText(u: Update): string {
  return u.type === "procedure" ? "בתוקף עד שיוחלף או יבוטל" : `מוצג ${validityLabel(u)}, ואז יורד אוטומטית`;
}

function nextBriefingText(): string {
  const bt = getSetting("briefing_time");
  return now() < at(today(), bt) ? `בתדריך הבוקר היום ב-${bt}` : `בתדריך הבוקר מחר ב-${bt}`;
}

function showProposal(s: Staff, id: number, prefix = "") {
  const u = updateById(id)!;
  const n = staffForUpdate(u).length;
  let text = `${prefix}📝 *הצעה לפרסום*\n\n`;
  text += `*סוג:* ${typeName(u.type)}${u.event_date ? ` – ${heDate(u.event_date)}${u.event_time ? ` ${u.event_time}` : ""}` : ""}\n`;
  text += `*תוקף:* ${validityText(u)}\n`;
  text += `*יעד:* ${targetLabel(u)} (${n} אנשי צוות)\n`;
  text += `*דחוף:* ${u.urgent ? "🚨 כן – יישלח מיד למי שרלוונטי היום" : `לא – ייכלל ${nextBriefingText()}`}\n`;
  text += `*אישור קריאה:* ${u.critical ? "❗ כן – תזכורות למי שלא אישר" : "לא"}\n\n`;
  text += `*כותרת:* ${u.title}\n*תוכן:* ${u.body}`;
  if (u.sensitive_note) text += `\n\n⚠️ *שימו לב:* ${u.sensitive_note}`;
  if (u.suggested_rewrite) text += `\n💡 *ניסוח מוצע:* ${u.suggested_rewrite}`;
  text += `\n\nאפשר לתקן בכתיבה חופשית ("רק לגפן", "לא דחוף", "עם אישור קריאה"...).`;
  const mid: Button = u.suggested_rewrite ? { id: `REWRITE:${id}`, title: "💡 ניסוח מוצע" } : { id: `EDIT:${id}`, title: "✏️ תיקון" };
  reply(s.phone, text, [{ id: `PUB:${id}`, title: u.sensitive_note ? "✅ פרסם כך" : "✅ פרסם" }, mid, { id: `DISCARD:${id}`, title: "🗑 בטל" }]);
}

function publish(s: Staff, id: number) {
  const u = updateById(id);
  if (!u || u.status !== "draft") return reply(s.phone, "העדכון כבר פורסם ✔");
  run("UPDATE updates SET status='active', published_at=?, valid_until=? WHERE id=?", now(), computeValidUntil(u), id);
  setConv(s.phone, null);
  const pub = updateById(id)!;
  log(`פורסם עדכון #${id}: ${pub.title} (${s.name})`);
  if (pub.urgent) {
    const n = pushNow(pub, "urgent_update", "🚨 *עדכון דחוף*");
    return reply(s.phone, `✅ פורסם ונשלח עכשיו ל-${n} אנשי צוות (#${id}).${pub.critical ? "\nמעקב אחרי אישורי קריאה במסך הניהול." : ""}`);
  }
  const n = staffForUpdate(pub).length;
  return reply(s.phone, `✅ פורסם (#${id}). ייכלל ${nextBriefingText()} עבור ${n} אנשי צוות.`, [
    { id: `SENDNOW:${id}`, title: "📣 שלח כבר עכשיו" },
  ]);
}

function sendNowToAll(s: Staff, id: number) {
  const u = updateById(id);
  if (!u || u.status !== "active") return;
  if (!claim(`sendnow:${id}`)) return reply(s.phone, "כבר נשלח ✔");
  const n = pushNow(u, "new_update", "📣 *עדכון חדש*");
  reply(s.phone, `📣 נשלח עכשיו ל-${n} אנשי צוות.`);
}

/** Send an update immediately to everyone relevant today who hasn't received it yet. */
function pushNow(u: Update, template: string, header: string): number {
  let n = 0;
  for (const p of staffForUpdate(u)) {
    if (one("SELECT 1 FROM deliveries WHERE update_id=? AND staff_id=?", u.id, p.id)) continue;
    deliver(p, { type: "updates", ids: [u.id], header }, { name: template, params: [u.title] });
    n++;
  }
  return n;
}

function cancelUpdate(s: Staff, id: number) {
  const u = updateById(id);
  if (!u || u.status !== "active") return reply(s.phone, `לא מצאתי עדכון פעיל מספר ${id}. כתבו "עדכונים פעילים" לרשימה.`);
  run("UPDATE updates SET status='cancelled' WHERE id=?", id);
  const got = all<{ staff_id: number }>("SELECT staff_id FROM deliveries WHERE update_id=?", id);
  for (const { staff_id } of got) {
    const p = staffById(staff_id);
    if (!p || p.status !== "active") continue;
    if (windowOpen(p)) sendSession(p.phone, `ℹ️ העדכון "${u.title}" בוטל ואינו בתוקף.`);
    else sendTemplate(p.phone, "update_cancelled", [u.title]);
  }
  log(`בוטל עדכון #${id}: ${u.title} (${s.name})`);
  reply(s.phone, `🗑 העדכון "${u.title}" בוטל. ${got.length ? `הודעת ביטול נשלחה ל-${got.length} שקיבלו אותו.` : "הוא עוד לא נשלח לאף אחד."}`);
}

function activeList(): string {
  const us = all<Update>("SELECT * FROM updates WHERE status='active' AND (valid_until IS NULL OR valid_until > ?) ORDER BY id", now());
  if (!us.length) return "אין עדכונים פעילים.";
  return "📋 *עדכונים פעילים*\n\n" + us.map((u) => {
    let line = `*#${u.id}* ${u.urgent ? "🚨" : ""}${u.critical ? "❗" : ""}${u.title} – ${targetLabel(u)}`;
    if (u.critical) {
      const total = one<{ c: number }>("SELECT COUNT(*) c FROM notified WHERE update_id=?", u.id)!.c;
      const read = one<{ c: number }>("SELECT COUNT(*) c FROM reads WHERE update_id=?", u.id)!.c;
      line += ` (אישרו ${read}/${total})`;
    }
    return line;
  }).join("\n") + `\n\nלביטול: "בטל 12"`;
}

function assignmentsToday(): string {
  const byUnit = new Map<number, string[]>();
  const none: string[] = [];
  for (const p of activeStaff()) {
    const u = unitAt(p.id);
    if (u) byUnit.set(u, [...(byUnit.get(u) ?? []), p.name]);
    else none.push(p.name);
  }
  let t = `🧭 *מי איפה עכשיו* (${hm(now())})\n`;
  for (const u of allUnits()) t += `\n*${u.name}:* ${(byUnit.get(u.id) ?? []).join(", ") || "—"}`;
  if (none.length) t += `\n\n*לא משובצים כרגע:* ${none.join(", ")}`;
  return t;
}

function describeAssignment(a: AssignmentDraft): string {
  const p = staffById(a.staff_id)!;
  const u = unitById(a.unit_id)!.name;
  if (a.kind === "fixed") return `${p.name} ← ${u}, באופן קבוע`;
  if (a.kind === "weekday") return `${p.name} ← ${u}, בכל יום ${HE_DAYS[a.weekday ?? 0]}`;
  const range = a.start_time && a.end_time ? `${a.start_time}–${a.end_time}` : a.end_time ? `עד ${a.end_time}` : a.start_time ? `מ-${a.start_time}` : "כל היום";
  return `${p.name} ← ${u}, ${heDate(a.date!)} ${range}`;
}

export function addTempStaff(by: Staff | null, d: AddStaffDraft) {
  const phone = normPhone(d.phone);
  const existing = staffByPhone(phone);
  let id: number;
  if (existing) {
    run("UPDATE staff SET name=?, status='active', kind=CASE WHEN role='manager' THEN kind ELSE 'temp' END, end_date=? WHERE id=?", d.name, d.end_date, existing.id);
    id = existing.id;
  } else {
    id = Number(run("INSERT INTO staff(name,phone,role,kind,end_date,status,created_at) VALUES(?,?,?,?,?,?,?)", d.name, phone, "staff", "temp", d.end_date, "active", now()).lastInsertRowid);
  }
  if (d.unit_id) addAssignment({ staff_id: id, unit_id: d.unit_id, kind: "fixed", weekday: null, date: null, start_time: null, end_time: null });
  log(`נוסף/ה עובד/ת זמני/ת: ${d.name} עד ${heDate(d.end_date)}${by ? ` (${by.name})` : ""}`);
  welcome(staffById(id)!);
  if (by) reply(by.phone, `✅ ${d.name} נוסף/ה. נשלחה הודעת פתיחה. הגישה תיסגר אוטומטית אחרי ${heDate(d.end_date)}.`);
  return id;
}
