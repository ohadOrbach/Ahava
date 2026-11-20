// Admin screen: Hebrew, RTL, mobile-first, server-rendered (no frontend build to maintain).
// Login: a one-time code sent to the manager's WhatsApp.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { all, one, run, Staff, Update } from "./db.js";
import { addDays, heDate, heDateTime, HE_DAYS, hm, now, today } from "./clock.js";
import {
  activeUpdates, addAssignment, allUnits, claim, validityLabel, dayTimeline, displayPhone, log, normPhone, staffById, staffByPhone, targetLabel, unitName, updateById,
} from "./domain.js";
import { criticalStatus, tick } from "./scheduler.js";
import { SETTINGS, SettingKey, getSetting, setSetting } from "./settings.js";
import { sendTemplate } from "./whatsapp.js";
import { typeName } from "./render.js";
import { addTempStaff } from "./bot.js";

const DEMO = process.env.DEMO !== "0";
const BOT_NUMBER = process.env.WHATSAPP_DISPLAY_NUMBER || "972500000000";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const wa = (s: string) => esc(s).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/_([^_\n]+)_/g, "<i>$1</i>").replace(/\n/g, "<br>");

function layout(title: string, active: string, body: string, user?: Staff) {
  const tabs = [
    ["/admin", "עדכונים"], ["/admin/staff", "צוות"], ["/admin/today", "שיבוצים"], ["/admin/units", "יחידות ו-QR"], ["/admin/settings", "הגדרות"],
  ];
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(getSetting("school_name"))}</title><link rel="stylesheet" href="/static/admin.css"></head><body>
<header><div class="brand">💬 ${esc(getSetting("school_name"))} · ניהול עדכונים</div>
${user ? `<div class="who">${esc(user.name)} · <a href="/admin/logout">יציאה</a></div>` : ""}</header>
${user ? `<nav>${tabs.map(([h, l]) => `<a href="${h}" class="${h === active ? "on" : ""}">${l}</a>`).join("")}</nav>` : ""}
<main>${body}</main></body></html>`;
}

function currentUser(req: FastifyRequest): Staff | undefined {
  const token = (req.cookies as any)?.sid;
  if (!token) return;
  const s = one<{ staff_id: number; expires: number }>("SELECT * FROM sessions WHERE token=?", token);
  if (!s || s.expires < Date.now()) return;
  const u = staffById(s.staff_id);
  return u?.role === "manager" && u.status === "active" ? u : undefined;
}
function login(reply: FastifyReply, staffId: number) {
  const token = crypto.randomBytes(24).toString("hex");
  run("INSERT INTO sessions(token,staff_id,expires) VALUES(?,?,?)", token, staffId, Date.now() + 30 * 24 * 3600 * 1000);
  reply.setCookie("sid", token, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 });
}

type H = (req: FastifyRequest, reply: FastifyReply, user: Staff) => unknown;
const guard = (h: H) => async (req: FastifyRequest, reply: FastifyReply) => {
  const user = currentUser(req);
  if (!user) return reply.redirect("/admin/login");
  return h(req, reply, user);
};
const html = (reply: FastifyReply, s: string) => reply.type("text/html; charset=utf-8").send(s);

function badge(u: Update) {
  return `<span class="tag t-${u.type}">${typeName(u.type)}</span>${u.urgent ? `<span class="tag urgent">דחוף</span>` : ""}${u.critical ? `<span class="tag critical">אישור קריאה</span>` : ""}`;
}

export function registerAdmin(app: FastifyInstance) {
  // ---------------- login ----------------
  app.get("/admin/login", async (req, reply) => {
    const q = req.query as any;
    const demoBtn = DEMO ? `<form method="post" action="/admin/demo-login"><button class="secondary">כניסה מהירה לדמו (רותם כהן)</button></form>` : "";
    if (q.phone) {
      return html(reply, layout("כניסה", "", `<section class="card narrow"><h1>הזנת קוד</h1>
        <p>שלחנו קוד בן 6 ספרות ל-WhatsApp של ${esc(displayPhone(q.phone))}.</p>
        <form method="post" action="/admin/verify"><input type="hidden" name="phone" value="${esc(q.phone)}">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="קוד" required><button>כניסה</button></form>
        ${q.err ? `<p class="err">קוד שגוי או שפג תוקפו.</p>` : ""}</section>`));
    }
    return html(reply, layout("כניסה", "", `<section class="card narrow"><h1>כניסה למסך הניהול</h1>
      <p>הזינו את מספר הטלפון שלכם. קוד כניסה יישלח אליכם ב-WhatsApp.</p>
      <form method="post" action="/admin/login"><input name="phone" inputmode="tel" placeholder="050-0000000" required><button>שלחו לי קוד</button></form>
      ${q.err ? `<p class="err">המספר אינו רשום כמנהל/ת.</p>` : ""}${demoBtn}</section>`));
  });
  app.post("/admin/login", async (req, reply) => {
    const phone = normPhone((req.body as any).phone ?? "");
    const s = staffByPhone(phone);
    if (!s || s.role !== "manager" || s.status !== "active") return reply.redirect("/admin/login?err=1");
    const code = String(crypto.randomInt(100000, 999999));
    run("INSERT INTO login_codes(phone,code,expires) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET code=excluded.code, expires=excluded.expires", phone, code, Date.now() + 10 * 60 * 1000);
    sendTemplate(phone, "login_code", [code]);
    return reply.redirect(`/admin/login?phone=${phone}`);
  });
  app.post("/admin/verify", async (req, reply) => {
    const b = req.body as any;
    const row = one<{ code: string; expires: number }>("SELECT * FROM login_codes WHERE phone=?", b.phone);
    if (!row || row.code !== String(b.code).trim() || row.expires < Date.now()) return reply.redirect(`/admin/login?phone=${b.phone}&err=1`);
    run("DELETE FROM login_codes WHERE phone=?", b.phone);
    login(reply, staffByPhone(b.phone)!.id);
    return reply.redirect("/admin");
  });
  app.post("/admin/demo-login", async (_req, reply) => {
    if (!DEMO) return reply.code(404).send();
    const m = one<Staff>("SELECT * FROM staff WHERE role='manager' AND status='active' ORDER BY id");
    if (m) login(reply, m.id);
    return reply.redirect("/admin");
  });
  app.get("/admin/logout", async (req, reply) => {
    run("DELETE FROM sessions WHERE token=?", (req.cookies as any)?.sid ?? "");
    reply.clearCookie("sid", { path: "/" });
    return reply.redirect("/admin/login");
  });

  // ---------------- updates ----------------
  app.get("/admin", guard(async (_req, reply, user) => {
    const us = activeUpdates().reverse();
    const cards = us.map((u) => {
      const delivered = one<{ c: number }>("SELECT COUNT(*) c FROM deliveries WHERE update_id=?", u.id)!.c;
      const notified = one<{ c: number }>("SELECT COUNT(*) c FROM notified WHERE update_id=?", u.id)!.c;
      let crit = "";
      if (u.critical) {
        const st = criticalStatus(u);
        const total = st.read.length + st.unread.length;
        const pct = total ? Math.round((st.read.length / total) * 100) : 0;
        crit = `<div class="crit"><div class="bar"><span style="width:${pct}%"></span></div>
          <div><b>אישרו קריאה: ${st.read.length}/${total}</b></div>
          ${st.unread.length ? `<details open><summary>טרם אישרו (${st.unread.length})</summary><div class="names">${st.unread.map((s) => esc(s.name)).join(" · ")}</div></details>` : ""}
          ${st.pendingDelivery.length ? `<details><summary>עוד לא נשלח – ייכלל בתדריך הבא (${st.pendingDelivery.length})</summary><div class="names">${st.pendingDelivery.map((s) => esc(s.name)).join(" · ")}</div></details>` : ""}
          ${st.read.length ? `<details><summary>אישרו (${st.read.length})</summary><div class="names">${st.read.map((s) => esc(s.name)).join(" · ")}</div></details>` : ""}</div>`;
      }
      const validity = validityLabel(u);
      return `<article class="card upd"><div class="row"><div>${badge(u)}</div><div class="muted">#${u.id}</div></div>
        <h3>${esc(u.title)}</h3><p>${wa(u.body)}</p>
        <div class="meta"><span>👥 ${esc(targetLabel(u))}</span>${u.event_date ? `<span>📅 ${heDate(u.event_date)}${u.event_time ? " " + u.event_time : ""}</span>` : ""}<span>⏳ ${validity}</span><span>📨 נשלח ל-${notified} · נפתח ע״י ${delivered}</span></div>
        ${crit}
        <form method="post" action="/admin/updates/${u.id}/cancel" onsubmit="return confirm('לבטל את העדכון? תישלח הודעת ביטול למי שקיבל אותו.')"><button class="link danger">ביטול עדכון</button></form>
      </article>`;
    }).join("");
    return html(reply, layout("עדכונים", "/admin", `<h1>עדכונים פעילים <span class="muted">(${us.length})</span></h1>
      <p class="muted">עדכונים נכתבים ב-WhatsApp לבוט. עדכונים שפג תוקפם יורדים מכאן ומהתדריכים אוטומטית.</p>${cards || "<p>אין עדכונים פעילים.</p>"}`, user));
  }));
  app.post("/admin/updates/:id/cancel", guard(async (req, reply, user) => {
    const id = Number((req.params as any).id);
    const u = updateById(id);
    if (u?.status === "active") {
      run("UPDATE updates SET status='cancelled' WHERE id=?", id);
      for (const { staff_id } of all<{ staff_id: number }>("SELECT staff_id FROM deliveries WHERE update_id=?", id)) {
        const p = staffById(staff_id);
        if (p?.status === "active") sendTemplate(p.phone, "update_cancelled", [u.title]);
      }
      log(`בוטל עדכון #${id}: ${u.title} (${user.name}, מסך ניהול)`);
    }
    return reply.redirect("/admin");
  }));

  // ---------------- staff ----------------
  app.get("/admin/staff", guard(async (_req, reply, user) => {
    const rows = all<Staff>("SELECT * FROM staff ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, role DESC, kind, name");
    const kindName = { fixed: "קבוע", rotating: "מתחלף", temp: "זמני" } as Record<string, string>;
    const statusName = { active: "פעיל", pending: "ממתין לאישור", ended: "הסתיים", rejected: "נדחה" } as Record<string, string>;
    const pending = rows.filter((s) => s.status === "pending");
    const unitOpts = allUnits().map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
    const body = `<h1>צוות</h1>
      ${pending.length ? `<section class="card warn"><h2>בקשות הצטרפות</h2>${pending.map((s) => `<div class="row"><div><b>${esc(s.name)}</b> · ${displayPhone(s.phone)}</div>
        <div class="actions"><form method="post" action="/admin/staff/${s.id}/approve"><button>אשר</button></form><form method="post" action="/admin/staff/${s.id}/reject"><button class="secondary">דחה</button></form></div></div>`).join("")}</section>` : ""}
      <section class="card"><h2>הוספת עובד/ת זמני/ת</h2>
      <form method="post" action="/admin/staff/add" class="grid">
        <label>שם<input name="name" required></label><label>טלפון<input name="phone" inputmode="tel" required></label>
        <label>גישה עד<input type="date" name="end_date" value="${addDays(today(), Number(getSetting("temp_default_days")))}" required></label>
        <label>יחידה<select name="unit_id"><option value="">—</option>${unitOpts}</select></label>
        <button>הוסף ושלח הודעת פתיחה</button></form></section>
      <section class="card"><h2>כל הצוות <span class="muted">(${rows.filter((s) => s.status === "active").length} פעילים)</span></h2>
      <div class="table"><table><thead><tr><th>שם</th><th>טלפון</th><th>תפקיד</th><th>יחידה עכשיו</th><th>סטטוס</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr class="${s.status !== "active" ? "dim" : ""}"><td>${esc(s.name)}</td><td dir="ltr">${displayPhone(s.phone)}</td>
        <td>${s.role === "manager" ? "הנהלה" : kindName[s.kind]}${s.kind === "temp" && s.end_date ? `<br><small>עד ${heDate(s.end_date)}</small>` : ""}</td>
        <td>${s.role === "staff" ? esc(unitName(s.current_unit_id)) : ""}</td><td>${statusName[s.status] ?? s.status}</td>
        <td>${s.status === "active" && s.role === "staff" ? `<form method="post" action="/admin/staff/${s.id}/end" onsubmit="return confirm('להפסיק את הגישה?')"><button class="link danger">הפסק גישה</button></form>` : ""}</td></tr>`).join("")}
      </tbody></table></div></section>`;
    return html(reply, layout("צוות", "/admin/staff", body, user));
  }));
  app.post("/admin/staff/add", guard(async (req, reply, user) => {
    const b = req.body as any;
    addTempStaff(user, { name: b.name, phone: b.phone, end_date: b.end_date, unit_id: b.unit_id ? Number(b.unit_id) : null });
    return reply.redirect("/admin/staff");
  }));
  app.post("/admin/staff/:id/:action", guard(async (req, reply, user) => {
    const { id, action } = req.params as any;
    const s = staffById(Number(id));
    if (!s) return reply.redirect("/admin/staff");
    if (action === "approve" && s.status === "pending") {
      run("UPDATE staff SET status='active' WHERE id=?", s.id);
      log(`בקשת הצטרפות אושרה: ${s.name} (${user.name}, מסך ניהול)`);
      claim(`briefing:${s.id}:${today()}`);
      const { deliver } = await import("./messenger.js");
      deliver(staffById(s.id)!, { type: "onboarding" }, { name: "welcome", params: [s.name.split(" ")[0], getSetting("school_name")] });
    }
    if (action === "reject" && s.status === "pending") run("UPDATE staff SET status='rejected' WHERE id=?", s.id);
    if (action === "end" && s.status === "active") {
      run("UPDATE staff SET status='ended' WHERE id=?", s.id);
      sendTemplate(s.phone, "access_ended", []);
      log(`הגישה של ${s.name} הופסקה (${user.name})`);
    }
    return reply.redirect("/admin/staff");
  }));

  // ---------------- today's assignments ----------------
  app.get("/admin/today", guard(async (_req, reply, user) => {
    const staff = all<Staff>("SELECT * FROM staff WHERE status='active' AND role='staff' ORDER BY name");
    const t = today();
    const byUnit = allUnits().map((u) => ({
      u,
      people: staff.flatMap((s) => dayTimeline(s.id, t).filter((seg) => seg.unit_id === u.id).map((seg) => ({ s, seg }))),
    }));
    const range = (f: string, to: string) => (f === "00:00" && to === "24:00" ? "כל היום" : `${f === "00:00" ? "" : f}–${to === "24:00" ? "" : to}`);
    const staffOpts = staff.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    const unitOpts = allUnits().map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join("");
    const body = `<h1>שיבוצים – ${heDate(t)} <span class="muted">(עכשיו ${hm(now())})</span></h1>
      <p class="muted">אפשר גם לכתוב לבוט: "דני בגפן היום עד הצהריים".</p>
      <div class="units">${byUnit.map(({ u, people }) => `<section class="card"><h2>${esc(u.name)} <span class="muted">(${people.length})</span></h2>
        <ul class="plain">${people.map(({ s, seg }) => `<li>${esc(s.name)} <small class="muted">${range(seg.from, seg.to)}${s.kind === "temp" ? " · זמני" : s.kind === "rotating" ? " · מתחלף" : ""}</small></li>`).join("") || "<li class='muted'>אין</li>"}</ul></section>`).join("")}</div>
      <section class="card"><h2>שינוי שיבוץ</h2><form method="post" action="/admin/today/assign" class="grid">
        <label>איש צוות<select name="staff_id">${staffOpts}</select></label><label>יחידה<select name="unit_id">${unitOpts}</select></label>
        <label>סוג<select name="kind"><option value="oneoff">חד פעמי</option><option value="weekday">קבוע ביום בשבוע</option><option value="fixed">קבוע</option></select></label>
        <label>תאריך (חד פעמי)<input type="date" name="date" value="${t}"></label>
        <label>יום בשבוע<select name="weekday">${HE_DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select></label>
        <label>משעה<input type="time" name="start_time"></label><label>עד שעה<input type="time" name="end_time"></label>
        <button>שמור</button></form></section>`;
    return html(reply, layout("שיבוצים", "/admin/today", body, user));
  }));
  app.post("/admin/today/assign", guard(async (req, reply, user) => {
    const b = req.body as any;
    const kind = b.kind as "oneoff" | "weekday" | "fixed";
    addAssignment({
      staff_id: Number(b.staff_id), unit_id: Number(b.unit_id), kind,
      weekday: kind === "weekday" ? Number(b.weekday) : null, date: kind === "oneoff" ? b.date : null,
      start_time: kind === "oneoff" && b.start_time ? b.start_time : null, end_time: kind === "oneoff" && b.end_time ? b.end_time : null,
    });
    log(`שיבוץ: ${staffById(Number(b.staff_id))?.name} ← ${unitName(Number(b.unit_id))} (${user.name}, מסך ניהול)`);
    tick();
    return reply.redirect("/admin/today");
  }));

  // ---------------- units & QR ----------------
  app.get("/admin/units", guard(async (_req, reply, user) => {
    const cards = await Promise.all(allUnits().map(async (u) => {
      const text = `${u.name} – מה עדכני? (קוד ${u.code})`;
      const link = `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(text)}`;
      const svg = await QRCode.toString(link, { type: "svg", margin: 1, width: 180 });
      return `<section class="card qr"><h2>${esc(u.name)}</h2>${svg}<p class="muted">סריקה פותחת WhatsApp עם ההודעה:<br><b>${esc(text)}</b></p>
        <p class="muted small">רשומים: מקבלים את העדכונים של היחידה. לא רשומים: נשלחת בקשת הצטרפות לאישור ההנהלה.</p></section>`;
    }));
    return html(reply, layout("יחידות ו-QR", "/admin/units", `<h1>יחידות וקודי QR לדלת</h1><p class="muted">להדפסה ותלייה על דלת כל משפחתון.</p><div class="units">${cards.join("")}</div>`, user));
  }));

  // ---------------- settings ----------------
  app.get("/admin/settings", guard(async (req, reply, user) => {
    const saved = (req.query as any).saved;
    const fields = (Object.keys(SETTINGS) as SettingKey[]).map((k) => {
      const d = SETTINGS[k];
      return `<label>${esc(d.label)}<input name="${k}" type="${d.type === "number" ? "number" : d.type}" step="any" value="${esc(getSetting(k))}"></label>`;
    }).join("");
    return html(reply, layout("הגדרות", "/admin/settings", `<h1>הגדרות</h1>${saved ? `<p class="ok">נשמר ✔</p>` : ""}
      <section class="card"><form method="post" action="/admin/settings" class="grid">${fields}<button>שמירה</button></form></section>`, user));
  }));
  app.post("/admin/settings", guard(async (req, reply) => {
    const b = req.body as any;
    for (const k of Object.keys(SETTINGS) as SettingKey[]) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
    return reply.redirect("/admin/settings?saved=1");
  }));
}
