// Delivery to staff, respecting the WhatsApp 24h window.
// If the window is open, content goes out directly as free session messages.
// If closed, we send one short approved template with a "show" button and park the content
// in the outbox; it is rendered and sent when the person taps (which opens the window).

import { all, run, Staff } from "./db.js";
import { now } from "./clock.js";
import { markNotified } from "./domain.js";
import { sendSession, sendTemplate } from "./whatsapp.js";
import {
  OutMsg, markOut, renderBriefing, renderOnboarding, renderUnitSwitch, renderUpdates, renderWhatsNew,
} from "./render.js";

export type Payload =
  | { type: "briefing" }
  | { type: "updates"; ids: number[]; header?: string }
  | { type: "unit"; unitId: number }
  | { type: "onboarding" }
  | { type: "whatsnew" };

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const windowOpen = (s: Staff) => !!s.last_inbound_at && now() - s.last_inbound_at < WINDOW_MS;

export function render(s: Staff, p: Payload): OutMsg[] {
  switch (p.type) {
    case "briefing": return renderBriefing(s);
    case "updates": return renderUpdates(s, p.ids, p.header);
    case "unit": return renderUnitSwitch(s, p.unitId);
    case "onboarding": return renderOnboarding(s);
    case "whatsnew": return renderWhatsNew(s);
  }
}

export function sendNow(s: Staff, msgs: OutMsg[]) {
  for (const m of msgs) sendSession(s.phone, m.text, m.buttons);
  markOut(s, msgs);
}

export function deliver(s: Staff, payload: Payload, template: { name: string; params: string[] }) {
  if (windowOpen(s)) {
    sendNow(s, render(s, payload));
    return "session";
  }
  // remember which updates this person was told about (for read-confirmation reminders)
  for (const m of render(s, payload)) for (const id of m.deliver ?? []) markNotified(id, s.id);
  // a newer briefing replaces an unopened older one
  if (payload.type === "briefing") run("DELETE FROM outbox WHERE staff_id=? AND kind='briefing'", s.id);
  run("INSERT INTO outbox(staff_id,kind,payload,created_at) VALUES(?,?,?,?)", s.id, payload.type, JSON.stringify(payload), now());
  sendTemplate(s.phone, template.name, template.params);
  return "template";
}

/** Called on any inbound message: send everything that was waiting. Returns true if something was sent. */
export function flushOutbox(s: Staff): boolean {
  const rows = all<{ id: number; payload: string }>("SELECT id,payload FROM outbox WHERE staff_id=? ORDER BY kind='briefing' DESC, id", s.id);
  if (!rows.length) return false;
  run("DELETE FROM outbox WHERE staff_id=?", s.id);
  // several parked items can overlap (e.g. briefing + urgent update): show each update once
  const shown = new Set<number>();
  for (const r of rows) {
    const msgs = render(s, JSON.parse(r.payload)).filter((m) => !m.deliver?.length || m.deliver.some((id) => !shown.has(id)));
    msgs.forEach((m) => m.deliver?.forEach((id) => shown.add(id)));
    if (msgs.length) sendNow(s, msgs);
  }
  return true;
}
