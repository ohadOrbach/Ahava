// Records the commercial demo video by driving the real system in the simulator.
// Usage: start the server (npm start), then: node promo/record.cjs [outDir]
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = path.resolve(process.argv[2] || "promo/out");
const W = 1920, H = 1080;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CSS = `
  .top button, .top input, .stats { display: none !important; }
  .top { padding: 14px 28px; }
  .top h1 { font-size: 22px; }
  .clock { font-size: 26px; transition: background .4s; }
  .clock.flash { background: #ffd54a; color: #1d2b26; }
  .wrap { grid-template-columns: 1fr 420px; }
  .phone { height: 800px; transition: transform .5s, box-shadow .5s, opacity .5s; }
  .side { transition: transform .5s, box-shadow .5s, opacity .5s; top: 80px; }
  .side iframe { height: 760px; }
  .wrap.focus { display: flex; justify-content: center; align-items: flex-start; gap: 28px; zoom: 1.45; padding-top: 8px; }
  .wrap.focus .phones { display: flex; gap: 28px; }
  .wrap.focus .phone:not(.spot), .wrap.focus .side:not(.spot) { display: none; }
  .wrap.focus .phone { width: 405px; height: 580px; }
  .wrap.focus .side { width: 420px; position: static; }
  .wrap.focus .side iframe { height: 545px; }
  .wrap.focus .phones:not(:has(.spot)) { display: none; }
  .spot { box-shadow: 0 0 0 4px #ffd54a, 0 20px 60px rgba(0,0,0,.30) !important; }
  .chips, .tabs { display: none !important; }
  #cap { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%) translateY(30px); opacity: 0; z-index: 50;
    background: rgba(10,40,31,.94); color: #fff; padding: 18px 34px; border-radius: 18px; font: 600 36px/1.3 system-ui, Arial;
    max-width: 1500px; text-align: center; transition: opacity .45s, transform .45s; box-shadow: 0 12px 40px rgba(0,0,0,.35); direction: rtl; }
  #cap.on { opacity: 1; transform: translateX(-50%) translateY(0); }
  #cap small { display: block; font-weight: 400; font-size: 24px; opacity: .85; margin-top: 4px; }
  #card { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
    background: radial-gradient(circle at 30% 20%, #19a37b, #0b4d3a 60%, #072e23); color: #fff; font-family: system-ui, Arial; direction: rtl;
    opacity: 0; pointer-events: none; transition: opacity .6s; text-align: center; padding: 60px; }
  #card.on { opacity: 1; }
  #card .logo { font-size: 96px; }
  #card h1 { font-size: 84px; margin: 0; font-weight: 800; letter-spacing: -1px; }
  #card h2 { font-size: 44px; margin: 0; font-weight: 400; opacity: .92; }
  #card ul { list-style: none; padding: 0; margin: 10px 0 0; font-size: 40px; line-height: 1.7; }
  #card ul li { opacity: 0; transform: translateY(14px); transition: opacity .5s, transform .5s; }
  #card ul li.in { opacity: 1; transform: none; }
  #card .tag { font-size: 30px; background: rgba(255,255,255,.14); padding: 10px 26px; border-radius: 99px; }
  #cursor { position: fixed; z-index: 70; width: 30px; height: 30px; left: 960px; top: 900px; pointer-events: none;
    transition: left .7s cubic-bezier(.4,.1,.2,1), top .7s cubic-bezier(.4,.1,.2,1); }
  #cursor svg { width: 30px; height: 30px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
  #cursor.click::after { content: ""; position: absolute; left: -16px; top: -16px; width: 60px; height: 60px; border-radius: 50%;
    background: rgba(255,213,74,.55); animation: ripple .5s ease-out forwards; }
  @keyframes ripple { from { transform: scale(.2); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
`;

(async () => {
  // fresh demo data
  await fetch(`${BASE}/sim/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.addStyleTag({ content: CSS });
  const FR = path.join(OUT, "frames");
  fs.rmSync(FR, { recursive: true, force: true });
  fs.mkdirSync(FR, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    const file = path.join(FR, `${String(frames.length).padStart(5, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<div id="cap"></div><div id="card"></div>
      <div id="cursor"><svg viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.5-3.5 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`);
    document.querySelector(".top h1").textContent = "💬 אהבה · עדכוני צוות";
  });
  await sleep(2000);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  const phone = (i) => page.locator(".phone").nth(i);
  const card = async (html, ms, stagger = 0) => {
    await page.evaluate((h) => { const c = document.getElementById("card"); c.innerHTML = h; c.classList.add("on"); }, html);
    if (stagger) {
      const n = await page.locator("#card li").count();
      for (let i = 0; i < n; i++) { await sleep(stagger); await page.evaluate((k) => document.querySelectorAll("#card li")[k].classList.add("in"), i); }
    }
    await sleep(ms);
  };
  const uncard = async () => { await page.evaluate(() => document.getElementById("card").classList.remove("on")); await sleep(700); };
  const caption = async (text, sub = "") => {
    await page.evaluate(([t, s]) => { const c = document.getElementById("cap"); c.classList.remove("on"); setTimeout(() => { c.innerHTML = t + (s ? `<small>${s}</small>` : ""); c.classList.add("on"); }, 250); }, [text, sub]);
    await sleep(500);
  };
  const nocap = async () => { await page.evaluate(() => document.getElementById("cap").classList.remove("on")); await sleep(400); };
  const spot = async (...sel) => {
    await page.evaluate((ix) => {
      document.querySelectorAll(".spot").forEach((e) => e.classList.remove("spot"));
      const wrap = document.querySelector(".wrap");
      wrap.classList.toggle("focus", ix.length > 0);
      for (const i of ix) (i === "side" ? document.querySelector(".side") : document.querySelectorAll(".phone")[i]).classList.add("spot");
    }, sel);
    await sleep(500);
  };
  const moveTo = async (loc) => {
    const b = await loc.boundingBox();
    await page.evaluate(([x, y]) => { const c = document.getElementById("cursor"); c.style.left = x + "px"; c.style.top = y + "px"; }, [b.x + b.width / 2, b.y + b.height / 2]);
    await sleep(650);
  };
  const click = async (loc) => {
    await moveTo(loc);
    await page.evaluate(() => { const c = document.getElementById("cursor"); c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); });
    await loc.click();
    await sleep(400);
  };
  const type = async (i, text) => {
    const ta = phone(i).locator("textarea");
    await click(ta);
    for (const ch of text) { await page.keyboard.insertText(ch); await sleep(16); }
    await sleep(400);
    await click(phone(i).locator(".compose button"));
    await sleep(1600);
  };
  const lastButton = (i, re) => phone(i).locator(".btns button").filter({ hasText: re }).last();
  const clock = async (body) => {
    await page.evaluate(() => document.getElementById("clock").classList.add("flash"));
    await fetch(`${BASE}/sim/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await sleep(2200);
    await page.evaluate(() => document.getElementById("clock").classList.remove("flash"));
  };
  const setPhone = async (i, phoneNo) => { await phone(i).locator("select").first().selectOption(phoneNo); await sleep(300); };

  // ---------------------------------------------------------------- 1. opening
  await card(`<div class="logo">💬</div><h1>כל עדכון מגיע למי שצריך.</h1><h2>בזמן. ב-WhatsApp. בלי שהצוות יעשה כלום.</h2>`, 3200);
  await card(`<h1 style="font-size:64px">מכירים את זה?</h1><ul>
    <li>📣 ההנהלה שולחת את אותה הודעה שוב ושוב</li><li>🌊 עדכונים חשובים נקברים בקבוצות</li>
    <li>❓ אף אחד לא יודע מה עדיין בתוקף</li><li>🚪 צוות זמני בכלל לא בקבוצה</li></ul>`, 1600, 550);
  await card(`<div class="logo">✨</div><h1>הבוט של פנימיית אהבה</h1><h2>המערכת מחליטה מה רלוונטי לכל איש צוות, ומתי.<br>החזרתיות עוברת מאנשים למערכת.</h2>`, 3000);
  await uncard();

  // ---------------------------------------------------------------- 2. morning briefing
  await spot(1, 2);
  await caption("☀️ 07:00 · תדריך בוקר אוטומטי", "כל אחד מקבל רק את מה שרלוונטי ליחידה שלו היום");
  await clock({ op: "advance", minutes: 10 });
  await sleep(1200);
  await click(lastButton(2, "הצג עדכונים"));
  await sleep(1800);
  await caption("🆕 חדש מוצג במלואו · 📌 ישן בשורה אחת", "אין חדש? אין הודעה. בלי רעש.");
  await sleep(3000);

  // ---------------------------------------------------------------- 3. manager writes free text
  await spot(0);
  await caption("✍️ ההנהלה כותבת חופשי, כמו לחבר", "בלי טפסים, בלי מערכת חדשה");
  await type(0, "דחוף: מחר בבוקר אין הסעות. החניכים של גפן ורימון נשארים בפנימייה עד 10:00");
  await caption("🧠 המערכת מבינה לבד: סוג, תוקף, דחיפות ויחידות", "והכותב/ת מאשר/ת לפני שזה יוצא");
  await sleep(2800);
  await caption("✏️ רוצים לשנות? פשוט כותבים", "״רק לגפן, עם אישור קריאה״");
  await type(0, "רק לגפן, עם אישור קריאה");
  await sleep(1600);
  await click(lastButton(0, "פרסם"));
  await sleep(1200);

  // ---------------------------------------------------------------- 4. urgent delivery + read confirmation
  await spot(0, 2, 1);
  await caption("🚨 דחוף? יוצא מיד, רק למי שעובד היום בגפן", "דני ברימון היום, ולכן לא מקבל");
  await sleep(3200);
  await caption("❗ עדכון קריטי דורש אישור קריאה", "תזכורות נשלחות רק למי שעוד לא אישר");
  await click(lastButton(2, "קראתי"));
  await sleep(2500);
  await spot("side");
  await caption("📊 ההנהלה רואה בזמן אמת מי אישר ומי לא", "בלי לרדוף אחרי אף אחד");
  await page.frameLocator("#admin").locator("body").evaluate(() => location.reload());
  await sleep(3600);

  // ---------------------------------------------------------------- 5. assignment by free text
  await spot(0, 1);
  await caption("🔄 שיבוץ? גם במשפט אחד", "״דני בגפן היום עד הצהריים״");
  await type(0, "דני בגפן היום עד הצהריים");
  await click(lastButton(0, "אשר"));
  await sleep(2000);
  await caption("📍 דני מקבל מיד תדריך קצר ליחידה החדשה", "ובצהריים, כשהוא חוזר לרימון, שוב תדריך קצר");
  await click(lastButton(1, "הצג"));
  await sleep(3000);

  // ---------------------------------------------------------------- 6. QR + temp staff
  await spot(3, 0);
  await caption("📷 צוות זמני? סורקים QR על דלת המשפחתון", "בלי להוסיף לקבוצות, בלי להסביר כלום");
  await fetch(`${BASE}/sim/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "972529990001", text: "זית – מה עדכני? (קוד ZYT-6643)" }) });
  await sleep(2400);
  await type(3, "ליאור בן חיים");
  await click(lastButton(0, "אשר"));
  await sleep(1400);
  await caption("✅ מאושר בלחיצה · נהלים ותדריך נשלחים לבד", "והגישה נסגרת אוטומטית בתאריך הסיום");
  await sleep(3000);

  // ---------------------------------------------------------------- 7. privacy
  await spot(0);
  await caption("🔒 שומרים על פרטיות החניכים", "המערכת מזהה מידע רגיש ומציעה ניסוח בלי פרטים");
  await type(0, "החניך יוסי מגפן צריך לקבל ריטלין ב-8 בבוקר");
  await sleep(3000);
  await click(lastButton(0, "בטל"));
  await sleep(1000);

  // ---------------------------------------------------------------- 9. admin
  await nocap();
  await spot("side");
  await caption("🖥️ מסך ניהול פשוט, בעברית, מהטלפון", "עדכונים פעילים · אישורי קריאה · צוות · שיבוצים · QR לכל דלת");
  const fr = page.frameLocator("#admin");
  for (const tab of ["שיבוצים", "צוות", "יחידות ו-QR", "עדכונים"]) {
    await fr.locator("nav a", { hasText: tab }).evaluate((a) => a.click());
    await sleep(1400);
  }
  await nocap();
  await spot();

  // ---------------------------------------------------------------- 10. closing
  await card(`<h1 style="font-size:70px">הצוות לא עושה כלום.<br>המערכת עושה הכל.</h1><ul>
    <li>☀️ תדריך בוקר אישי, רק כשיש חדש</li><li>🚨 דחוף מגיע מיד, רק למי שרלוונטי</li>
    <li>❗ אישורי קריאה ותזכורות אוטומטיות</li><li>🔄 מעבר בין משפחתונים, צוות זמני ו-QR</li><li>🔒 פרטיות החניכים במרכז</li></ul>`, 2200, 500);
  await card(`<div class="logo">💬</div><h1>אהבה · עדכוני צוות</h1><h2>הכל ב-WhatsApp. בלי אפליקציה. בלי לוח.</h2><div class="tag">רוצים לראות את זה אצלכם? דברו איתנו</div>`, 4200);

  await cdp.send("Page.stopScreencast");
  await sleep(300);
  await browser.close();
  // frames arrive only when the screen changes: give each one its real on-screen duration
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 1.5;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(3)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(path.join(OUT, "frames.txt"), lines.join("\n"));
  const mp4 = path.join(OUT, "ahava-demo.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(OUT, "frames.txt"),
    "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p,fade=t=in:st=0:d=0.6", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", mp4]);
  console.log("video:", mp4, frames.length, "frames");
})();
