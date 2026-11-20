// Hebrew message rendering for staff. Content is rendered at the moment it is shown,
// so a briefing opened at 09:00 reflects cancellations made at 08:00.

import { Staff, Update, unitIds } from "./db.js";
import { heDate, heRelDate, hm, now, today } from "./clock.js";
import {
  dayTimeline, isDelivered, isRead, markDelivered, relevantUpdates, targetLabel, unitAt, unitName, unitsOnDay, firstName, updateById,
} from "./domain.js";
import { Button } from "./whatsapp.js";
import { getSetting } from "./settings.js";

export interface OutMsg { text: string; buttons?: Button[]; deliver?: number[] }

const TYPE_ICON = { procedure: "📘", event: "📅", schedule: "🔄" } as const;
const TYPE_NAME = { procedure: "נוהל", event: "אירוע", schedule: "שינוי בלו״ז" } as const;
export const typeName = (t: Update["type"]) => TYPE_NAME[t];

function when(u: Update): string {
  if (!u.event_date) return "";
  return ` – ${heRelDate(u.event_date)}${u.event_time ? ` ${u.event_time}` : ""}`;
}
function flags(u: Update): string {
  return `${u.urgent ? "🚨 " : ""}${u.critical ? "❗ " : ""}`;
}
export function itemFull(u: Update): string {
  return `${flags(u)}${TYPE_ICON[u.type]} *${u.title}*${when(u)}\n${u.body}\n_👥 ${targetLabel(u)}_`;
}
export function itemLine(u: Update): string {
  return `• ${TYPE_ICON[u.type]} ${u.title}${when(u)}`;
}
function criticalMsg(u: Update): OutMsg {
  return {
    text: `❗ *עדכון שדורש אישור קריאה*\n\n${TYPE_ICON[u.type]} *${u.title}*${when(u)}\n${u.body}\n\nנא ללחוץ "קראתי" לאישור.`,
    buttons: [{ id: `READ:${u.id}`, title: "✔ קראתי" }],
    deliver: [u.id],
  };
}
const notRead = (s: Staff) => (u: Update) => u.critical && !isRead(u.id, s.id);

/** The unit(s) whose updates a person should get right now. */
export function currentUnits(s: Staff): number[] {
  const u = unitAt(s.id);
  if (u) return [u];
  return unitsOnDay(s.id, today());
}

function unitLine(s: Staff): string {
  const tl = dayTimeline(s.id, today());
  if (!tl.length) return "";
  if (tl.length === 1) return `📍 היחידה שלך היום: *${unitName(tl[0].unit_id)}*`;
  return "📍 היום: " + tl.map((x) => `*${unitName(x.unit_id)}* ${x.from}–${x.to === "24:00" ? "סוף היום" : x.to}`).join(" ← ");
}

export function renderBriefing(s: Staff): OutMsg[] {
  const items = relevantUpdates(currentUnits(s));
  const t = today();
  const news = items.filter((u) => !isDelivered(u.id, s.id));
  const todayEvents = items.filter((u) => isDelivered(u.id, s.id) && u.type === "event" && u.event_date === t);
  const old = items.filter((u) => isDelivered(u.id, s.id) && u.type !== "procedure" && !todayEvents.includes(u));
  const procCount = items.filter((u) => u.type === "procedure").length;

  const newPlain = news.filter((u) => !u.critical);
  const newCritical = news.filter((u) => u.critical);

  let text = `☀️ *תדריך בוקר – ${heDate(t)}*\n${unitLine(s)}`;
  if (newPlain.length) text += `\n\n*🆕 חדש:*\n\n` + newPlain.map(itemFull).join("\n\n");
  if (todayEvents.length) text += `\n\n*📅 היום:*\n` + todayEvents.map(itemLine).join("\n");
  if (old.length) text += `\n\n*📌 עדיין בתוקף:*\n` + old.map(itemLine).join("\n");
  if (newCritical.length) text += `\n\n❗ ${newCritical.length === 1 ? "עדכון אחד דורש" : `${newCritical.length} עדכונים דורשים`} אישור קריאה – בהודעה הבאה.`;
  if (!news.length && !todayEvents.length) text += `\n\nאין עדכונים חדשים מאז הפעם הקודמת ✔`;
  text += `\n\n📘 ${procCount} נהלים בתוקף – כתבו *נהלים* לרשימה המלאה.`;

  return [{ text, deliver: newPlain.map((u) => u.id) }, ...newCritical.map(criticalMsg)];
}

export function renderWhatsNew(s: Staff, unitOverride?: number): OutMsg[] {
  const units = unitOverride ? [unitOverride] : currentUnits(s);
  const items = relevantUpdates(units).filter((u) => u.type !== "procedure");
  const procCount = relevantUpdates(units).filter((u) => u.type === "procedure").length;
  const label = units.map(unitName).filter(Boolean).join(", ");
  let text = `📋 *מה עדכני${label ? ` – ${label}` : ""}* (${hm(now())})`;
  const plain = items.filter((u) => !notRead(s)(u));
  if (plain.length) text += `\n\n` + plain.map(itemFull).join("\n\n");
  else if (!items.length) text += `\n\nאין עדכונים פעילים מלבד הנהלים.`;
  text += `\n\n📘 ${procCount} נהלים בתוקף – כתבו *נהלים* לרשימה.`;
  return [{ text, deliver: plain.map((u) => u.id) }, ...items.filter(notRead(s)).map(criticalMsg)];
}

export function renderProcedures(s: Staff, intro = "📘 *נהלים בתוקף*"): OutMsg[] {
  const units = unitsOnDay(s.id, today());
  const procs = relevantUpdates(units.length ? units : []).filter((u) => u.type === "procedure");
  if (!procs.length) return [{ text: `${intro}\n\nאין נהלים פעילים כרגע.` }];
  const plain = procs.filter((u) => !notRead(s)(u));
  const text = `${intro}\n\n` + plain.map((u, i) => `${i + 1}. ${flags(u)}*${u.title}*\n${u.body}`).join("\n\n");
  return [{ text, deliver: plain.map((u) => u.id) }, ...procs.filter(notRead(s)).map(criticalMsg)];
}

/** Short briefing when moving to another unit mid-day: only that unit's specific updates. */
export function renderUnitSwitch(s: Staff, unitId: number): OutMsg[] {
  const items = unitSpecific(unitId);
  let text = `🔄 *עברת ל${unitName(unitId)}*`;
  if (!items.length) return [{ text: text + `\n\nאין עדכונים מיוחדים ליחידה.` }];
  const plain = items.filter((u) => !notRead(s)(u));
  text += `\n\n*עדכונים ליחידה:*\n\n` + plain.map((u) => (isDelivered(u.id, s.id) ? itemLine(u) : itemFull(u))).join("\n\n");
  return [{ text, deliver: plain.map((u) => u.id) }, ...items.filter(notRead(s)).map(criticalMsg)];
}
export const unitSpecific = (unitId: number) => relevantUpdates([unitId]).filter((u) => !u.target_all && unitIds(u).includes(unitId));

export function renderUpdates(s: Staff, ids: number[], header?: string): OutMsg[] {
  const us = ids.map(updateById).filter((u): u is Update => !!u && u.status === "active" && (!u.valid_until || u.valid_until > now()));
  if (!us.length) return []; // expired or cancelled meanwhile: nothing to show
  const plain = us.filter((u) => !notRead(s)(u));
  const out: OutMsg[] = [];
  if (plain.length) out.push({ text: (header ? header + "\n\n" : "") + plain.map(itemFull).join("\n\n"), deliver: plain.map((u) => u.id) });
  return out.concat(us.filter(notRead(s)).map(criticalMsg));
}

export function renderOnboarding(s: Staff): OutMsg[] {
  const school = getSetting("school_name");
  return [
    { text: `👋 *שלום ${firstName(s)}, ברוכים הבאים ל${school}!*\n\nאין צורך לעשות כלום: כל בוקר יגיע אליך תדריך עם מה שרלוונטי ליחידה שלך, ועדכונים דחופים יגיעו מיד.\n\nבכל רגע אפשר לכתוב:\n• *מה עדכני?* – העדכונים הפעילים ליחידה שלך\n• *נהלים* – כל הנהלים בתוקף\n\nקודם כל, הנהלים שחשוב להכיר:` },
    ...renderProcedures(s, "📘 *נהלים בתוקף*"),
    ...renderWhatsNew(s),
  ];
}

export function helpText(isManager: boolean): string {
  const staff = `אפשר לכתוב:\n• *מה עדכני?* – העדכונים הפעילים ליחידה שלך\n• *נהלים* – כל הנהלים בתוקף`;
  if (!isManager) return `🤖 אני הבוט של עדכוני הצוות.\n\n${staff}`;
  return `🤖 *מה אפשר לעשות כמנהל/ת:*\n\n• לכתוב עדכון בחופשיות – אציע סוג, תוקף, דחיפות ויחידות, ותאשרו לפני שליחה\n• לשבץ: "דני בגפן היום עד 12:00", "מיכל קבוע ברימון", "עומר בזית בימי שלישי"\n• להוסיף זמני: "הוסף זמני אלה כהן 0521234567 עד 30/11 בגפן"\n• *עדכונים פעילים* – רשימה עם מספרים\n• *בטל 12* – ביטול עדכון מספר 12\n• *שיבוצים* – מי איפה היום\n\n${staff}`;
}

export function markOut(s: Staff, msgs: OutMsg[]) {
  for (const m of msgs) for (const id of m.deliver ?? []) markDelivered(id, s.id);
}
