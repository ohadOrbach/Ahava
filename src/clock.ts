// Virtual clock. All business logic reads time from here so the simulator can fast-forward.
// Local time is Asia/Jerusalem (process.env.TZ is set at startup).

let offsetMs = 0;

export function now(): number {
  return Date.now() + offsetMs;
}
export function setNow(ms: number) {
  offsetMs = ms - Date.now();
}
export function getOffset() {
  return offsetMs;
}
export function setOffset(ms: number) {
  offsetMs = ms;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function hm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00`).getDay();
}
/** Local date + "HH:MM" -> epoch ms. */
export function at(dateStr: string, time = "00:00"): number {
  return new Date(`${dateStr}T${time}:00`).getTime();
}
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d.getTime());
}
export function today(): string {
  return ymd(now());
}

export const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

/** "יום שלישי 24/11" */
export function heDate(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `יום ${HE_DAYS[weekdayOf(dateStr)]} ${Number(d)}/${Number(m)}`;
}
/** "היום" / "מחר" / "יום שלישי 24/11" */
export function heRelDate(dateStr: string): string {
  const t = today();
  if (dateStr === t) return "היום";
  if (dateStr === addDays(t, 1)) return "מחר";
  if (dateStr === addDays(t, -1)) return "אתמול";
  return heDate(dateStr);
}
export function heDateTime(ms: number): string {
  return `${heRelDate(ymd(ms))} ${hm(ms)}`;
}
