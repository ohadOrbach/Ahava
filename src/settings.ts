import { one, run } from "./db.js";

/** Client-editable settings (admin -> הגדרות). */
export const SETTINGS = {
  school_name: { label: "שם המוסד", type: "text", def: "פנימיית אהבה" },
  briefing_time: { label: "שעת תדריך בוקר", type: "time", def: "07:00" },
  briefing_days: { label: "ימים לשליחת תדריך (0=ראשון ... 6=שבת)", type: "text", def: "0,1,2,3,4,5,6" },
  event_eve_time: { label: "שעת תזכורת לאירוע ביום שלפני", type: "time", def: "19:00" },
  event_dayof_hours: { label: "תזכורת ביום האירוע: כמה שעות לפני", type: "number", def: "2" },
  critical_interval_hours: { label: "תזכורת לעדכון קריטי שלא אושר: כל כמה שעות", type: "number", def: "3" },
  critical_max_reminders: { label: "מקסימום תזכורות לעדכון קריטי", type: "number", def: "3" },
  quiet_start: { label: "שעות שקט (ללא תזכורות) מ-", type: "time", def: "22:00" },
  quiet_end: { label: "שעות שקט עד", type: "time", def: "07:00" },
  temp_default_days: { label: "תקופת גישה ברירת מחדל לעובד זמני (ימים)", type: "number", def: "14" },
  template_cost_usd: { label: "עלות משוערת להודעת תבנית (דולר)", type: "number", def: "0.005" },
} as const;

export type SettingKey = keyof typeof SETTINGS;

export function getSetting(key: SettingKey): string {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key=?", key);
  return row?.value ?? SETTINGS[key].def;
}
export function getNum(key: SettingKey): number {
  return Number(getSetting(key));
}
export function setSetting(key: SettingKey, value: string) {
  run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
}
