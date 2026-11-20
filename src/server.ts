process.env.TZ = process.env.TZ || "Asia/Jerusalem";

import Fastify from "fastify";
import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import crypto from "node:crypto";
import path from "node:path";
import { all, getMeta, migrate, one, setMeta } from "./db.js";
import { getOffset, heDate, hm, now, setOffset, today, at, addDays } from "./clock.js";
import { handleInbound } from "./bot.js";
import { tick } from "./scheduler.js";
import { registerAdmin } from "./admin.js";
import { seed } from "./seed.js";
import { getNum, getSetting } from "./settings.js";
import { LIVE } from "./whatsapp.js";
import { LLM_ENABLED } from "./parser.js";
import { allUnits } from "./domain.js";

const DEMO = process.env.DEMO !== "0";
const PORT = Number(process.env.PORT || 3000);

migrate();
if (!one("SELECT 1 FROM units LIMIT 1")) {
  if (DEMO) seed();
} else {
  setOffset(Number(getMeta("clock_offset") || 0));
}

const app = Fastify({ logger: false });

// keep the raw body for WhatsApp webhook signature verification
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as any).rawBody = body;
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
});
await app.register(formbody);
await app.register(cookie);
await app.register(fstatic, { root: path.join(process.cwd(), "public"), prefix: "/static/" });

// ------------------------------------------------------------------ WhatsApp Cloud API webhook
app.get("/webhook", async (req, reply) => {
  const q = req.query as any;
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) return reply.send(q["hub.challenge"]);
  return reply.code(403).send();
});
app.post("/webhook", async (req, reply) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    const sig = String(req.headers["x-hub-signature-256"] ?? "");
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update((req as any).rawBody ?? "").digest("hex");
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return reply.code(401).send();
  }
  const body = req.body as any;
  for (const entry of body.entry ?? [])
    for (const change of entry.changes ?? [])
      for (const m of change.value?.messages ?? []) {
        try {
          if (m.type === "text") await handleInbound({ phone: m.from, text: m.text.body });
          else if (m.type === "interactive" && m.interactive?.button_reply)
            await handleInbound({ phone: m.from, button: { id: m.interactive.button_reply.id, title: m.interactive.button_reply.title } });
          else if (m.type === "button") await handleInbound({ phone: m.from, button: { id: m.button.payload, title: m.button.text } });
        } catch (e) {
          console.error("inbound error", e);
        }
      }
  return reply.send({ ok: true });
});

registerAdmin(app);

// ------------------------------------------------------------------ demo simulator
if (DEMO) {
  app.get("/", async (_req, reply) => reply.sendFile("console.html"));

  app.get("/sim/personas", async () => ({
    staff: all("SELECT id,name,phone,role,kind,status,end_date FROM staff ORDER BY role DESC, id"),
    units: allUnits(),
  }));

  app.get("/sim/state", async (req) => {
    const after = Number((req.query as any).after || 0);
    const msgs = all("SELECT * FROM messages WHERE id>? ORDER BY id", after);
    const tpl = one<{ c: number }>("SELECT COUNT(*) c FROM messages WHERE kind='template'")!.c;
    const ses = one<{ c: number }>("SELECT COUNT(*) c FROM messages WHERE kind='session'")!.c;
    return {
      now: now(),
      clock: `${heDate(today())} · ${hm(now())}`,
      messages: msgs,
      log: all("SELECT * FROM log ORDER BY id DESC LIMIT 40"),
      stats: { templates: tpl, sessions: ses, cost: +(tpl * getNum("template_cost_usd")).toFixed(3) },
      staffVersion: one<{ v: string }>("SELECT COUNT(*) || '-' || COALESCE(SUM(CASE status WHEN 'active' THEN 1 ELSE 0 END),0) v FROM staff")!.v,
      llm: LLM_ENABLED,
    };
  });

  app.post("/sim/send", async (req) => {
    const b = req.body as any;
    await handleInbound({ phone: b.phone, text: b.text, button: b.button });
    tick();
    return { ok: true };
  });

  app.post("/sim/clock", async (req) => {
    const b = req.body as any;
    let target = now();
    if (b.op === "advance") target += Number(b.minutes) * 60 * 1000;
    if (b.op === "next-briefing") {
      const bt = at(today(), getSetting("briefing_time"));
      target = now() < bt ? bt : at(addDays(today(), 1), getSetting("briefing_time"));
    }
    if (b.op === "set") target = new Date(b.local).getTime();
    // step through time so every due event fires in order
    const step = 15 * 60 * 1000;
    let t = now();
    while (t < target) {
      t = Math.min(t + step, target);
      setOffset(t - Date.now());
      tick();
    }
    if (target < now()) setOffset(target - Date.now());
    setMeta("clock_offset", String(getOffset()));
    return { ok: true };
  });

  app.post("/sim/reset", async () => {
    seed();
    tick();
    return { ok: true };
  });
}

setInterval(() => {
  try { tick(); setMeta("clock_offset", String(getOffset())); } catch (e) { console.error("tick error", e); }
}, 10_000);
tick();

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`Ahava bot on http://localhost:${PORT}  (${DEMO ? "demo simulator" : "production"}, WhatsApp: ${LIVE ? "Cloud API" : "simulated"}, parser: ${LLM_ENABLED ? "Claude" : "rule-based"})`);
