// Time-driven sends. tick() is idempotent: every send is guarded by a key in sent_keys,
// and conditions are "is it due by now?" so a restart or a clock jump catches up correctly.

import { all, one, run, Update } from "./db.js";
import { addDays, at, hm, now, today, weekdayOf } from "./clock.js";
import {
  activeStaff, activeUpdates, claim, firstName, isDelivered, isRead, isRelevant, log, staffById, unitAt, unitName, unitsOnDay,
} from "./domain.js";
import { deliver, windowOpen } from "./messenger.js";
import { renderBriefing, unitSpecific } from "./render.js";
import { getNum, getSetting } from "./settings.js";
import { sendSession, sendTemplate } from "./whatsapp.js";

const HOUR = 60 * 60 * 1000;

function inQuietHours(): boolean {
  const t = hm(now()), qs = getSetting("quiet_start"), qe = getSetting("quiet_end");
  return qs > qe ? t >= qs || t < qe : t >= qs && t < qe;
}

export function tick() {
  const t = today();
  const briefingAt = at(t, getSetting("briefing_time"));
  const dayStarted = now() >= briefingAt;

  // 1. temporary staff whose access period ended
  for (const s of activeStaff().filter((s) => s.kind === "temp" && s.end_date && s.end_date < t)) {
    run("UPDATE staff SET status='ended' WHERE id=?", s.id);
    run("DELETE FROM outbox WHERE staff_id=?", s.id);
    if (windowOpen(s)) sendSession(s.phone, "תקופת הגישה שלך לעדכוני הצוות הסתיימה. תודה על עבודתך! 🙏");
    else sendTemplate(s.phone, "access_ended", []);
    log(`הגישה של ${s.name} הסתיימה (עובד/ת זמני/ת)`);
  }

  const staff = activeStaff();

  // 2. mid-day unit switch -> short briefing for the new unit
  for (const s of staff) {
    const u = unitAt(s.id);
    if (u === s.current_unit_id) continue;
    run("UPDATE staff SET current_unit_id=? WHERE id=?", u, s.id);
    if (!u || !dayStarted || !s.current_unit_id) continue;
    const items = unitSpecific(u);
    log(`${s.name} עבר/ה ל${unitName(u)} (${hm(now())})`);
    if (!items.length) continue;
    deliver(s, { type: "unit", unitId: u }, { name: "unit_switch", params: [unitName(u), String(items.length)] });
  }

  // 3. morning briefing: only if there is news
  const days = getSetting("briefing_days").split(",").map((x) => Number(x.trim()));
  if (dayStarted && now() < briefingAt + 12 * HOUR && days.includes(weekdayOf(t))) {
    let sent = 0;
    for (const s of staff) {
      if (!claim(`briefing:${s.id}:${t}`)) continue;
      const msgs = renderBriefing(s);
      const newCount = msgs.reduce((n, m) => n + (m.deliver?.length ?? 0), 0);
      const hasTodayEvent = activeUpdates().some((u) => u.type === "event" && u.event_date === t && isRelevant(u, unitsOnDay(s.id, t)));
      if (!newCount && !hasTodayEvent) continue; // no news, no briefing
      deliver(s, { type: "briefing" }, { name: "daily_briefing", params: [firstName(s), String(newCount || 1)] });
      sent++;
    }
    if (sent) log(`נשלח תדריך בוקר ל-${sent} אנשי צוות`);
  }

  // 4. event reminders: the evening before, and N hours before on the day
  const eveAt = getSetting("event_eve_time");
  const beforeH = getNum("event_dayof_hours");
  for (const u of activeUpdates().filter((u) => u.type === "event" && u.event_date)) {
    const eventMs = u.event_time ? at(u.event_date!, u.event_time) : at(u.event_date!, "00:00");
    const when = u.event_time ? `${u.event_date === t ? "היום" : "מחר"} ב-${u.event_time}` : u.event_date === t ? "היום" : "מחר";
    const isEve = u.event_date === addDays(t, 1) && now() >= at(t, eveAt);
    const isDayOf = !!u.event_time && u.event_date === t && now() >= eventMs - beforeH * HOUR && now() < eventMs;
    if (!isEve && !isDayOf) continue;
    const phase = isEve ? "eve" : "day";
    let n = 0;
    for (const s of activeStaff()) {
      if (!isRelevant(u, unitsOnDay(s.id, u.event_date!))) continue;
      if (!claim(`event:${phase}:${u.id}:${s.id}`)) continue;
      deliver(s, { type: "updates", ids: [u.id], header: "📅 *תזכורת לאירוע*" }, { name: "event_reminder", params: [u.title, when] });
      n++;
    }
    if (n) log(`תזכורת לאירוע "${u.title}" (${isEve ? "ערב לפני" : "ביום האירוע"}) נשלחה ל-${n}`);
  }

  // 5. critical updates not yet confirmed: remind only those who haven't
  if (!inQuietHours()) {
    const interval = getNum("critical_interval_hours") * HOUR;
    const max = getNum("critical_max_reminders");
    for (const u of activeUpdates().filter((u) => u.critical)) {
      const rows = all<{ staff_id: number; delivered_at: number }>("SELECT staff_id, at AS delivered_at FROM notified WHERE update_id=?", u.id);
      let n = 0;
      for (const r of rows) {
        if (isRead(u.id, r.staff_id)) continue;
        const s = staffById(r.staff_id);
        if (!s || s.status !== "active") continue;
        const rem = one<{ count: number; last_at: number }>("SELECT count,last_at FROM reminders WHERE update_id=? AND staff_id=?", u.id, s.id);
        const count = rem?.count ?? 0;
        if (count >= max || now() - (rem?.last_at ?? r.delivered_at) < interval) continue;
        run(`INSERT INTO reminders(update_id,staff_id,count,last_at) VALUES(?,?,1,?)
             ON CONFLICT(update_id,staff_id) DO UPDATE SET count=count+1, last_at=excluded.last_at`, u.id, s.id, now());
        deliver(s, { type: "updates", ids: [u.id] }, { name: "critical_reminder", params: [u.title] });
        n++;
      }
      if (n) log(`תזכורת לאישור קריאה "${u.title}" נשלחה ל-${n} שטרם אישרו`);
    }
  }
}

export function criticalStatus(u: Update) {
  const rows = all<{ staff_id: number }>("SELECT staff_id FROM notified WHERE update_id=?", u.id);
  const pendingDelivery = activeStaff().filter((s) => isRelevant(u, unitsOnDay(s.id, today())) && !isDelivered(u.id, s.id) && !rows.some((r) => r.staff_id === s.id));
  const read = rows.filter((r) => isRead(u.id, r.staff_id)).map((r) => staffById(r.staff_id)!).filter(Boolean);
  const unread = rows.filter((r) => !isRead(u.id, r.staff_id)).map((r) => staffById(r.staff_id)!).filter(Boolean);
  return { read, unread, pendingDelivery };
}

