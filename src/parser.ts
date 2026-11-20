// Understanding free text from managers.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise (and on any error) a rule-based Hebrew parser.
// The manager always confirms or corrects the proposal before anything is sent.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { addDays, HE_DAYS, hm, now, today, weekdayOf } from "./clock.js";
import { allUnits, activeStaff } from "./domain.js";
import { Staff, Unit } from "./db.js";

export interface UpdateDraft {
  type: "procedure" | "event" | "schedule";
  title: string;
  body: string;
  target_all: boolean;
  units: number[];
  urgent: boolean;
  critical: boolean;
  event_date: string | null;
  event_time: string | null;
  sensitive_note: string | null;
  suggested_rewrite: string | null;
}
export interface AssignmentDraft {
  staff_id: number;
  unit_id: number;
  kind: "fixed" | "weekday" | "oneoff";
  weekday: number | null;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
}
export interface AddStaffDraft { name: string; phone: string; end_date: string; unit_id: number | null }

export type Intent =
  | { intent: "update"; update: UpdateDraft }
  | { intent: "assignment"; assignment: AssignmentDraft }
  | { intent: "add_staff"; staff: AddStaffDraft }
  | { intent: "unknown" };

export const LLM_ENABLED = !!process.env.ANTHROPIC_API_KEY;

// =====================================================================================
// Rule-based Hebrew parser
// =====================================================================================

const HEB = "\\u0590-\\u05FF";
const PREFIX = "(?:[ובלמהשכ]{0,3})";
const wordRe = (w: string) => new RegExp(`(?:^|[^${HEB}])${PREFIX}${w}(?=$|[^${HEB}])`);
const has = (text: string, words: string[]) => words.some((w) => wordRe(w).test(text));

const URGENT = ["דחוף", "דחופה", "מיידי", "מיידית", "מיד", "עכשיו", "בהקדם"];
const CRITICAL = ["קריטי", "קריטית", "חשוב מאוד", "חובה לקרוא", "לאשר קריאה", "אישור קריאה", "נא לאשר", "בטיחות", "חירום"];
const PROCEDURE = ["נוהל", "נוהל חדש", "מעכשיו", "מהיום והלאה", "החל מהיום", "יש להקפיד", "חובה", "אסור", "תמיד", "בכל יום", "בכל ערב", "בכל בוקר", "כל יום"];
const SCHEDULE = ["שינוי", "במקום", "הוקדם", "תוקדם", "יוקדם", "נדחה", "תידחה", "יידחה", "יוזז", "תוזז", "מבוטל", "מבוטלת", "בוטל", "בוטלה", "לוח זמנים", 'לו"ז', "לו״ז"];
const EVENT = ["טיול", "אסיפה", "ישיבה", "ישיבת", "מסיבה", "ביקור", "הרצאה", "טקס", "הופעה", "פעילות", "ערב", "השתלמות", "הדרכה", "תרגיל", "מפגש", "יום הולדת", "חגיגה", "סדנה"];
const ALL_STAFF = ["כולם", "לכולם", "כל הצוות", "כל המדריכים", "כל אנשי הצוות"];
const SENSITIVE = ["תרופה", "תרופות", "כדור", "כדורים", "ריטלין", "אבחנה", "אבחון", "פסיכיאטר", "פסיכולוג", "אשפוז", "מחלה", "חולה", "רווחה", "עובדת סוציאלית", "משטרה", "פגיעה", "אובדני", "אובדנות", "התעללות", "הריון", "סמים", "אלימות", "בית משפט", "חום"];

function findUnits(text: string, units: Unit[]): number[] {
  return units.filter((u) => wordRe(u.name).test(text)).map((u) => u.id);
}
function findStaff(text: string, staff: Staff[]): Staff | undefined {
  // full name first, then first name
  return staff.find((s) => text.includes(s.name)) ?? staff.find((s) => wordRe(s.name.split(" ")[0]).test(text));
}

const DAY_RE = new RegExp(`(?:ביום|יום)\\s+(${HE_DAYS.join("|")})`);
function findDate(text: string): string | null {
  const t = today();
  if (wordRe("מחרתיים").test(text)) return addDays(t, 2);
  if (wordRe("מחר").test(text)) return addDays(t, 1);
  if (wordRe("היום").test(text) || wordRe("הערב").test(text) || wordRe("הבוקר").test(text)) return t;
  const dm = text.match(/(?<![\d:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/);
  if (dm) {
    const d = Number(dm[1]), m = Number(dm[2]);
    let y = dm[3] ? Number(dm[3].length === 2 ? "20" + dm[3] : dm[3]) : new Date(now()).getFullYear();
    let iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!dm[3] && iso < addDays(t, -30)) iso = `${y + 1}${iso.slice(4)}`;
    return iso;
  }
  const dw = text.match(DAY_RE);
  if (dw) {
    const target = HE_DAYS.indexOf(dw[1]);
    for (let i = 1; i <= 7; i++) if (weekdayOf(addDays(t, i)) === target) return addDays(t, i);
  }
  return null;
}
function normTime(h: string, m?: string) {
  return `${String(Number(h)).padStart(2, "0")}:${m ?? "00"}`;
}
function findTime(text: string): string | null {
  const m = text.match(/(?<![\d/.])(\d{1,2}):(\d{2})(?![\d/.])/);
  if (m) return normTime(m[1], m[2]);
  const s = text.match(/בשעה\s+(\d{1,2})(?![\d/.:])/);
  if (s) return normTime(s[1]);
  return null;
}
function findRange(text: string): { start: string | null; end: string | null } {
  const T = "(\\d{1,2})(?::(\\d{2}))?";
  const word = (w: string | undefined) => (w === "הצהריים" || w === "צהריים" ? "12:00" : w === "הערב" ? "18:00" : w === "הבוקר" ? "08:00" : null);
  let start: string | null = null, end: string | null = null;
  const e = text.match(new RegExp(`עד\\s*(?:ה-?|השעה\\s*)?(?:${T}|(הצהריים|צהריים|הערב))`));
  if (e) end = e[1] ? normTime(e[1], e[2]) : word(e[3]);
  const s = text.match(new RegExp(`(?:^|\\s)(?:מ-?|מה-?|מהשעה\\s*|החל מ-?)(?:${T}(?![\\d/.])|(הצהריים|צהריים|הערב|הבוקר))`));
  if (s) start = s[1] ? normTime(s[1], s[2]) : word(s[3]);
  return { start, end };
}
function makeTitle(text: string): string {
  const PRE = /^(נוהל חדש|נוהל|עדכון חשוב|עדכון|הודעה|שימו לב|לתשומת לבכם|דחוף|חשוב מאוד|חשוב|חובה לקרוא ולאשר|חובה לקרוא|נא לקרוא ולאשר|נא לאשר קריאה)\s*[:!,.\-–]*\s*/u;
  let t = text.trim();
  while (PRE.test(t)) t = t.replace(PRE, "");
  t = t.split(/[.\n!]/)[0].trim();
  const words = t.split(/\s+/);
  if (words.length > 8) t = words.slice(0, 8).join(" ") + "…";
  return t || text.slice(0, 40);
}
function sensitiveCheck(text: string): { note: string | null; rewrite: string | null } {
  if (!has(text, SENSITIVE)) return { note: null, rewrite: null };
  return {
    note: "נראה שההודעה כוללת מידע רגיש על חניך/ה (בריאות, רווחה או מצב אישי). מומלץ לא לכתוב שמות ופרטים בהודעה.",
    rewrite: "עדכון אישי לגבי חניך/ה ביחידה – הפרטים אצל רכז/ת היחידה. נא לפנות לפני תחילת המשמרת.",
  };
}

function heuristicUpdate(text: string): UpdateDraft {
  const units = findUnits(text, allUnits());
  const date = findDate(text);
  const time = findTime(text);
  let type: UpdateDraft["type"];
  if (!date) type = has(text, SCHEDULE) && !has(text, PROCEDURE) ? "schedule" : "procedure";
  else if (/נוהל|מהיום|מעכשיו|החל מ|בכל (יום|ערב|בוקר|לילה)/.test(text)) type = "procedure";
  else if (has(text, SCHEDULE) || has(text, ["אין", "לא יתקיים", "לא תתקיים", "לא תהיה", "לא יהיה"])) type = "schedule";
  else if (has(text, EVENT) || time) type = "event";
  else type = "schedule";
  const urgent = has(text, URGENT);
  const critical = has(text, CRITICAL);
  const sens = sensitiveCheck(text);
  return {
    type, title: makeTitle(text), body: text.trim(),
    target_all: units.length === 0 || has(text, ALL_STAFF), units,
    urgent, critical,
    event_date: type === "procedure" ? null : date ?? today(),
    event_time: type === "event" ? time : null,
    sensitive_note: sens.note, suggested_rewrite: sens.rewrite,
  };
}

function heuristicParse(text: string): Intent {
  const staff = activeStaff();
  const units = allUnits();
  const phone = text.match(/(?:\+?972|0)5\d[-\s]?\d{3}[-\s]?\d{4}/);
  if (phone && /הוס[ףפ]|זמני|זמנית|חדש|חדשה|מחליף|מחליפה/.test(text)) {
    const unitIds = findUnits(text, units);
    const endM = text.match(/עד\s*(?:ה-?)?(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)/);
    const end = endM ? findDate(endM[1]) : null;
    const name = text
      .replace(phone[0], " ")
      .replace(/עד\s*(?:ה-?)?\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/, " ")
      .replace(/(?:^|\s)(הוסף|הוסיפי|תוסיף|תוסיפי|להוסיף|עובד|עובדת|זמני|זמנית|חדש|חדשה|מחליף|מחליפה|מדריך|מדריכה|את|טלפון|טל)(?=\s|$|:|,)/g, " ")
      .replace(new RegExp(`(?:^|\\s)${PREFIX}(${units.map((u) => u.name).join("|")})(?=\\s|$)`, "g"), " ")
      .replace(/[,:;\-–]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      intent: "add_staff",
      staff: { name: name || "עובד/ת זמני/ת", phone: phone[0], end_date: end ?? "", unit_id: unitIds[0] ?? null },
    };
  }
  const person = findStaff(text, staff);
  const unitIds = findUnits(text, units);
  const words = text.trim().split(/\s+/).length;
  if (person && unitIds.length === 1 && words <= 14 && !has(text, [...EVENT, ...SCHEDULE, "נוהל"])) {
    const { start, end } = findRange(text);
    const wd = text.match(new RegExp(`בימי\\s+(${HE_DAYS.join("|")})|כל\\s+יום\\s+(${HE_DAYS.join("|")})`));
    let a: AssignmentDraft;
    if (wd) a = { staff_id: person.id, unit_id: unitIds[0], kind: "weekday", weekday: HE_DAYS.indexOf(wd[1] ?? wd[2]), date: null, start_time: null, end_time: null };
    else if (/קבוע|קבועה|באופן קבוע|מעכשיו|מהיום והלאה/.test(text))
      a = { staff_id: person.id, unit_id: unitIds[0], kind: "fixed", weekday: null, date: null, start_time: null, end_time: null };
    else a = { staff_id: person.id, unit_id: unitIds[0], kind: "oneoff", weekday: null, date: findDate(text) ?? today(), start_time: start, end_time: end };
    return { intent: "assignment", assignment: a };
  }
  if (words < 3) return { intent: "unknown" };
  return { intent: "update", update: heuristicUpdate(text) };
}

function heuristicCorrect(d: UpdateDraft, text: string): UpdateDraft | null {
  const out = { ...d };
  let changed = false;
  const set = <K extends keyof UpdateDraft>(k: K, v: UpdateDraft[K]) => { out[k] = v; changed = true; };
  if (/לא\s+דחו[ףפ]/.test(text)) set("urgent", false);
  else if (has(text, ["דחוף", "דחופה", "מיידי", "מיד"])) set("urgent", true);
  if (/לא\s+(קריטי|חשוב)|בלי\s+אישור|ללא\s+אישור/.test(text)) set("critical", false);
  else if (has(text, ["קריטי", "קריטית", "עם אישור", "אישור קריאה", "לאשר"])) set("critical", true);
  if (has(text, ["נוהל"])) { set("type", "procedure"); set("event_date", null); set("event_time", null); }
  else if (has(text, ["אירוע"])) set("type", "event");
  else if (has(text, ["שינוי", "לוח זמנים", 'לו"ז', "לו״ז"])) set("type", "schedule");
  if (has(text, ALL_STAFF)) { set("target_all", true); set("units", []); }
  const units = findUnits(text, allUnits());
  if (units.length) {
    const add = /גם/.test(text);
    set("target_all", false);
    set("units", add ? [...new Set([...out.units, ...units])] : units);
  }
  const date = findDate(text);
  if (date && out.type !== "procedure") set("event_date", date);
  const time = findTime(text);
  if (time && out.type !== "procedure") set("event_time", time);
  const title = text.match(/כותרת\s*[:：]\s*(.+)/);
  if (title) set("title", title[1].trim());
  const body = text.match(/(?:תוכן|טקסט|נוסח)\s*[:：]\s*([\s\S]+)/);
  if (body) { set("body", body[1].trim()); const s = sensitiveCheck(out.body); out.sensitive_note = s.note; out.suggested_rewrite = s.rewrite; }
  if (out.type !== "procedure" && !out.event_date) out.event_date = today();
  return changed ? out : null;
}

// =====================================================================================
// Claude-based parser
// =====================================================================================

const UpdateSchema = z.object({
  type: z.enum(["procedure", "event", "schedule"]),
  title: z.string().describe("Short Hebrew title, max ~8 words"),
  body: z.string().describe("The message text in Hebrew, as the manager wrote it (or the sensitive-safe version only if asked)"),
  target_all: z.boolean(),
  unit_names: z.array(z.string()).describe("Exact unit names from the list; empty if target_all"),
  urgent: z.boolean(),
  critical: z.boolean(),
  event_date: z.string().nullable().describe("YYYY-MM-DD for event/schedule; null for procedure"),
  event_time: z.string().nullable().describe("HH:MM or null"),
  sensitive_note: z.string().nullable().describe("Hebrew warning if the text contains sensitive personal details about a minor, else null"),
  suggested_rewrite: z.string().nullable().describe("Hebrew neutral rewrite without the sensitive details, else null"),
});
const IntentSchema = z.object({
  intent: z.enum(["update", "assignment", "add_staff", "unknown"]),
  update: UpdateSchema.nullable(),
  assignment: z
    .object({
      staff_name: z.string(), unit_name: z.string(), kind: z.enum(["fixed", "weekday", "oneoff"]),
      weekday: z.number().nullable(), date: z.string().nullable(), start_time: z.string().nullable(), end_time: z.string().nullable(),
    })
    .nullable(),
  add_staff: z.object({ name: z.string(), phone: z.string(), end_date: z.string().nullable(), unit_name: z.string().nullable() }).nullable(),
});

let client: Anthropic | null = null;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

function context(): string {
  const t = today();
  return [
    `Today is ${t} (${HE_DAYS[weekdayOf(t)]}), current time ${hm(now())}, timezone Asia/Jerusalem.`,
    `Units (mishpachtonim): ${allUnits().map((u) => u.name).join(", ")}.`,
    `Staff names: ${activeStaff().map((s) => s.name).join(", ")}.`,
  ].join("\n");
}

const SYSTEM = `You help managers of an Israeli boarding school (פנימייה) send updates to counselors via WhatsApp.
Classify a manager's Hebrew message.

intent:
- "update": an update for staff.
- "assignment": placing a staff member in a unit (e.g. "דני בגפן היום עד הצהריים"). kind: oneoff (specific date, optional start/end HH:MM; "עד הצהריים" = end 12:00), weekday (0=Sunday..6=Saturday, recurring), fixed (permanent).
- "add_staff": adding a temporary staff member by phone number with optional end date (YYYY-MM-DD) and unit.
- "unknown": anything else.

For updates:
- type: "procedure" = standing rule valid until replaced; "event" = something happening at a date/time; "schedule" = a change to the usual schedule on a date.
- urgent = staff on duty today must know right now. critical = requires read confirmation (safety, mandatory reading, explicitly asked to confirm).
- target_all unless specific units are named.
- Keep body as written. Title: short, neutral.
- Privacy: content about minors must be minimal. If the text includes a child's name together with health, medication, welfare, legal, family or other sensitive details, set sensitive_note (Hebrew, one sentence) and suggested_rewrite (Hebrew, neutral, no name or details, e.g. points to the unit coordinator).
Write all user-facing strings in Hebrew.`;

async function llmParse(text: string, current?: UpdateDraft): Promise<Intent | null> {
  client ??= new Anthropic();
  const user = current
    ? `${context()}\n\nCurrent draft update (JSON):\n${JSON.stringify(current)}\n\nThe manager replied with a correction. Apply it and return intent "update" with the full corrected update:\n${text}`
    : `${context()}\n\nManager message:\n${text}`;
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(IntentSchema) },
    messages: [{ role: "user", content: user }],
  } as any);
  if (res.stop_reason === "refusal") return null;
  const p = res.parsed_output as z.infer<typeof IntentSchema> | null;
  if (!p) return null;
  const units = allUnits();
  const unitId = (n: string | null | undefined) => units.find((u) => u.name === n?.trim())?.id;
  if (p.intent === "update" && p.update) {
    const u = p.update;
    const ids = u.unit_names.map(unitId).filter((x): x is number => !!x);
    return {
      intent: "update",
      update: {
        type: u.type, title: u.title, body: u.body, target_all: u.target_all || ids.length === 0, units: ids,
        urgent: u.urgent, critical: u.critical,
        event_date: u.type === "procedure" ? null : u.event_date ?? today(), event_time: u.type === "procedure" ? null : u.event_time,
        sensitive_note: u.sensitive_note, suggested_rewrite: u.suggested_rewrite,
      },
    };
  }
  if (p.intent === "assignment" && p.assignment) {
    const a = p.assignment;
    const s = findStaff(a.staff_name, activeStaff());
    const uid = unitId(a.unit_name);
    if (!s || !uid) return null;
    return {
      intent: "assignment",
      assignment: { staff_id: s.id, unit_id: uid, kind: a.kind, weekday: a.weekday, date: a.kind === "oneoff" ? a.date ?? today() : null, start_time: a.start_time, end_time: a.end_time },
    };
  }
  if (p.intent === "add_staff" && p.add_staff) {
    const a = p.add_staff;
    return { intent: "add_staff", staff: { name: a.name, phone: a.phone, end_date: a.end_date ?? "", unit_id: unitId(a.unit_name) ?? null } };
  }
  return { intent: "unknown" };
}

// =====================================================================================
// Public API
// =====================================================================================

export async function parseManagerText(text: string): Promise<Intent> {
  if (LLM_ENABLED) {
    try {
      const r = await llmParse(text);
      if (r) return r;
    } catch (e) {
      console.error("LLM parse failed, using rule-based parser:", (e as Error).message);
    }
  }
  return heuristicParse(text);
}

/** Cheap check: does this read as an assignment or a new staff member rather than a correction? */
export function isCommandLike(text: string): boolean {
  const r = heuristicParse(text);
  return r.intent === "assignment" || r.intent === "add_staff";
}

export async function correctDraft(d: UpdateDraft, text: string): Promise<UpdateDraft | null> {
  if (LLM_ENABLED) {
    try {
      const r = await llmParse(text, d);
      if (r?.intent === "update") return r.update;
    } catch (e) {
      console.error("LLM correction failed, using rule-based parser:", (e as Error).message);
    }
  }
  return heuristicCorrect(d, text);
}

