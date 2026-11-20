// WhatsApp transport layer.
//  - Every message in/out is written to the `messages` table (audit log + simulator view).
//  - SimTransport: nothing else to do; the simulator UI reads the messages table.
//  - CloudApiTransport: also POSTs to the Meta WhatsApp Cloud API.
//
// WhatsApp rules modelled here:
//  - Free-form ("session") messages are only allowed within 24h of the person's last message to us.
//  - Outside that window, only pre-approved templates can be sent (billed per message).

import { run } from "./db.js";
import { now } from "./clock.js";

export interface Button { id: string; title: string }

/** Templates to submit to Meta for approval (category UTILITY unless noted). Text is what staff see. */
export const TEMPLATES: Record<string, { category: string; text: string; buttons: string[] }> = {
  daily_briefing: { category: "UTILITY", text: "בוקר טוב {{1}} ☀️\nעדכונים חדשים עבורך להיום: {{2}}", buttons: ["הצג עדכונים"] },
  urgent_update: { category: "UTILITY", text: "🚨 עדכון דחוף מההנהלה: {{1}}", buttons: ["הצג"] },
  new_update: { category: "UTILITY", text: "📣 עדכון חדש מההנהלה: {{1}}", buttons: ["הצג"] },
  critical_reminder: { category: "UTILITY", text: "⏰ תזכורת: יש לאשר קריאה של העדכון \"{{1}}\".", buttons: ["הצג"] },
  event_reminder: { category: "UTILITY", text: "📅 תזכורת: {{1}} – {{2}}", buttons: ["הצג"] },
  unit_switch: { category: "UTILITY", text: "🔄 עברת ל{{1}}. עדכונים ליחידה: {{2}}", buttons: ["הצג"] },
  welcome: { category: "UTILITY", text: "שלום {{1}} 👋\nברוכים הבאים לעדכוני הצוות של {{2}}. כאן יגיעו אליך רק העדכונים שרלוונטיים לך.", buttons: ["התחל"] },
  update_cancelled: { category: "UTILITY", text: "ℹ️ העדכון \"{{1}}\" בוטל ואינו בתוקף.", buttons: [] },
  access_ended: { category: "UTILITY", text: "תקופת הגישה שלך לעדכוני הצוות הסתיימה. תודה על עבודתך! 🙏", buttons: [] },
  join_request: { category: "UTILITY", text: "🙋 בקשת הצטרפות: {{1}} ({{2}}){{3}}", buttons: ["אשר", "דחה"] },
  login_code: { category: "AUTHENTICATION", text: "קוד הכניסה שלך למסך הניהול: {{1}}", buttons: [] },
};

export function renderTemplate(name: string, params: string[]): string {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`unknown template ${name}`);
  return t.text.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? "");
}

interface Transport {
  sendText(phone: string, text: string, buttons?: Button[]): Promise<void>;
  sendTemplate(phone: string, name: string, params: string[], buttons: Button[]): Promise<void>;
}

class SimTransport implements Transport {
  async sendText() {}
  async sendTemplate() {}
}

class CloudApiTransport implements Transport {
  constructor(private token: string, private phoneNumberId: string) {}
  private async post(body: unknown) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...(body as object) }),
    });
    if (!res.ok) console.error("WhatsApp send failed", res.status, await res.text());
  }
  async sendText(phone: string, text: string, buttons?: Button[]) {
    if (buttons?.length) {
      await this.post({
        to: phone, type: "interactive",
        interactive: {
          type: "button", body: { text: text.slice(0, 1024) },
          action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      });
    } else {
      await this.post({ to: phone, type: "text", text: { body: text } });
    }
  }
  async sendTemplate(phone: string, name: string, params: string[], buttons: Button[]) {
    const components: any[] = [];
    if (params.length) components.push({ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) });
    buttons.forEach((b, i) =>
      components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: b.id }] })
    );
    await this.post({ to: phone, type: "template", template: { name, language: { code: "he" }, components } });
  }
}

export const LIVE = !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
const transport: Transport = LIVE
  ? new CloudApiTransport(process.env.WHATSAPP_TOKEN!, process.env.WHATSAPP_PHONE_NUMBER_ID!)
  : new SimTransport();

export function sendSession(phone: string, text: string, buttons?: Button[]) {
  run(
    "INSERT INTO messages(phone,direction,kind,template,body,buttons,at) VALUES(?,?,?,?,?,?,?)",
    phone, "out", "session", null, text, buttons?.length ? JSON.stringify(buttons) : null, now()
  );
  transport.sendText(phone, text, buttons).catch((e) => console.error(e));
}

export function sendTemplate(phone: string, name: string, params: string[], payloads: string[] = []) {
  const t = TEMPLATES[name];
  const buttons = t.buttons.map((title, i) => ({ id: payloads[i] ?? "SHOW", title }));
  run(
    "INSERT INTO messages(phone,direction,kind,template,body,buttons,at) VALUES(?,?,?,?,?,?,?)",
    phone, "out", "template", name, renderTemplate(name, params), buttons.length ? JSON.stringify(buttons) : null, now()
  );
  transport.sendTemplate(phone, name, params, buttons).catch((e) => console.error(e));
}

export function logInbound(phone: string, text: string) {
  run("INSERT INTO messages(phone,direction,kind,template,body,buttons,at) VALUES(?,?,?,?,?,?,?)", phone, "in", "inbound", null, text, null, now());
}
