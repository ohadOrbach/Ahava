// Demo data: 5 managers, 20 counselors (15 fixed, 5 rotating), 5 temporary staff, 5 units, a few live updates.
// Content is deliberately generic: no details about children.

import { run, wipe, setMeta } from "./db.js";
import { addDays, at, getOffset, now, setNow, today, weekdayOf, ymd } from "./clock.js";
import { addAssignment, computeValidUntil, markDelivered, markRead, staffForUpdate } from "./domain.js";
import { one, Update } from "./db.js";

const UNITS: [string, string][] = [["גפן", "GFN-4821"], ["רימון", "RMN-7356"], ["תאנה", "TAN-2194"], ["זית", "ZYT-6643"], ["חיטה", "HTA-5810"]];
const MANAGERS = ["רותם כהן", "אבי לוי", "שירה מזרחי", "נועה פרץ", "יוסי ביטון"];
const FIXED = ["מיכל אברהם", "עומר דהן", "הדס פרידמן", "איתי שלום", "ליאור גבאי", "שני אזולאי", "אלון חדד", "מאיה רוזן", "רועי ששון", "טל וקנין", "עדי סויסה", "נטע קליין", "אורי בן דוד", "ספיר עמר", "גיל נחום"];
const ROTATING = ["דני אוחיון", "ענבל שטרן", "עידו כץ", "רוני מלכה", "שקד יוסף"];
const TEMPS = ["אלה גולן", "ברק שמש", "דור לנדאו", "הילה צור", "ירדן ברק"];

const phone = (i: number) => `9725200${String(i).padStart(5, "0")}`;

export function seed() {
  wipe();
  // virtual clock: today at 06:55, right before the morning briefing
  setNow(at(ymd(Date.now()), "06:55"));
  setMeta("clock_offset", String(getOffset()));
  const T = today();

  UNITS.forEach(([name, code]) => run("INSERT INTO units(name,code) VALUES(?,?)", name, code));

  let i = 1;
  const add = (name: string, role: string, kind: string, end: string | null = null) =>
    Number(run("INSERT INTO staff(name,phone,role,kind,end_date,status,created_at) VALUES(?,?,?,?,?,?,?)", name, phone(i++), role, kind, end, "active", now()).lastInsertRowid);

  MANAGERS.forEach((m) => add(m, "manager", "fixed"));
  FIXED.forEach((n, k) => {
    const id = add(n, "staff", "fixed");
    addAssignment({ staff_id: id, unit_id: (k % 5) + 1, kind: "fixed", weekday: null, date: null, start_time: null, end_time: null });
  });
  ROTATING.forEach((n, k) => {
    const id = add(n, "staff", "rotating");
    // rotate across units by weekday; Dani is in Rimon today
    for (let wd = 0; wd < 7; wd++) {
      const unit = n.startsWith("דני") && wd === weekdayOf(T) ? 2 : ((wd + k) % 5) + 1;
      addAssignment({ staff_id: id, unit_id: unit, kind: "weekday", weekday: wd, date: null, start_time: null, end_time: null });
    }
  });
  TEMPS.forEach((n, k) => {
    const end = k === 0 ? T : addDays(T, 5 + k * 3); // Ella's access ends today -> removed tonight
    const id = add(n, "staff", "temp", end);
    addAssignment({ staff_id: id, unit_id: (k % 5) + 1, kind: "fixed", weekday: null, date: null, start_time: null, end_time: null });
  });

  const daysAgo = (d: number) => now() - d * 24 * 3600 * 1000;
  const upd = (u: Partial<Update> & { title: string; body: string; type: Update["type"] }, publishedDaysAgo: number, delivered: boolean, readShare = 0) => {
    const full = { target_all: 1, units: "[]", urgent: 0, critical: 0, event_date: null, event_time: null, ...u } as any;
    const id = Number(run(
      `INSERT INTO updates(author_id,type,title,body,target_all,units,urgent,critical,event_date,event_time,valid_until,status,created_at,published_at)
       VALUES(1,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      full.type, full.title, full.body, full.target_all, full.units, full.urgent, full.critical, full.event_date, full.event_time,
      computeValidUntil(full), daysAgo(publishedDaysAgo), daysAgo(publishedDaysAgo)
    ).lastInsertRowid);
    if (delivered) {
      const u2 = one<Update>("SELECT * FROM updates WHERE id=?", id)!;
      staffForUpdate(u2).forEach((s, k, arr) => {
        markDelivered(id, s.id);
        if (k < Math.round(arr.length * readShare)) markRead(id, s.id);
      });
    }
    return id;
  };

  upd({ type: "procedure", title: "נוהל יציאה מהפנימייה", body: "כל יציאה של חניך מהפנימייה נרשמת בטופס היציאה בדלפק, כולל שעת חזרה משוערת." }, 20, true);
  upd({ type: "procedure", title: "החלפת משמרת", body: "בהחלפת משמרת עוברים יחד על יומן היחידה לפני היציאה." }, 12, true);
  upd({ type: "procedure", title: "כיבוי אורות בגפן", body: "כיבוי אורות בגפן ב-22:00, גם בסופי שבוע.", target_all: 0, units: "[1]" }, 6, true);
  upd({ type: "procedure", title: "נקודת כינוס חדשה בחירום", body: "נקודת הכינוס בחירום עברה למגרש הכדורסל. יש לעבור על זה עם החניכים השבוע.", critical: 1 }, 1, true, 0.65);
  upd({ type: "event", title: "ישיבת צוות חודשית", body: "ישיבת צוות חודשית בחדר המורים. נוכחות חובה לכל הצוות הקבוע.", event_date: addDays(T, 1), event_time: "14:00" }, 3, true);
  upd({ type: "schedule", title: "ארוחת ערב מוקדמת ברימון", body: "ארוחת הערב ברימון תוקדם ל-18:00 בגלל פעילות ערב.", target_all: 0, units: "[2]", event_date: addDays(T, 2) }, 1, true);
  // new since yesterday -> triggers this morning's briefing
  upd({ type: "schedule", title: "ארוחת צהריים ב-13:30", body: "היום ארוחת הצהריים תתחיל ב-13:30 במקום 13:00 בגלל עבודות במטבח.", event_date: T }, 0.4, false);
  upd({ type: "event", title: "הופעה בגפן ובתאנה", body: "הופעה משותפת לגפן ותאנה במועדון. מדריכי המשמרת מלווים את החניכים.", target_all: 0, units: "[1,3]", event_date: T, event_time: "19:30" }, 0.4, false);

  run("UPDATE staff SET current_unit_id=NULL");
}
