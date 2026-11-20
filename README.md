# Ahava staff-updates bot (MVP + demo)

A WhatsApp bot that delivers management updates to boarding-school staff. Staff do nothing: the system decides what is relevant to each person (by the unit they work in today) and when to send it. Management writes free text to the bot, confirms the bot's proposal, and the system handles briefings, reminders, expiry and read confirmations.

This repo runs end to end **without a WhatsApp number**: a built-in simulator shows several phones side by side, the admin screen, and a clock you can fast-forward.

## Run the demo

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`, no native modules).

```bash
npm install
npm start
# open http://localhost:3000
```

The demo seeds 5 managers, 20 counselors (15 fixed, 5 rotating), 5 temporary staff, 5 units and a few live updates. The clock starts at 06:55 today. **↺ איפוס דמו** resets everything.

Optional: `ANTHROPIC_API_KEY=...` switches update understanding from the built-in Hebrew rules to Claude. Without a key, the rule-based parser handles the demo scenarios.

### תסריט דמו (מוצג גם בלשונית "תסריט דמו")

1. **תדריך בוקר:** לוחצים "+15 דק׳". כל הצוות מקבל הודעת תבנית קצרה (בתשלום). לחיצה על "הצג עדכונים" פותחת את התדריך המלא (חינם). חדש מוצג במלואו, ישן בשורה אחת. מי שאין לו חדש לא מקבל כלום.
2. **עדכון דחוף:** בטלפון של רותם (הנהלה) בוחרים דוגמה "דחוף: מחר אין הסעות...". הבוט מציע סוג, תוקף, יעד ודחיפות. "פרסם". רק הצוות של גפן ורימון מקבל.
3. **תיקון חופשי:** "רק לזית", "לא דחוף", "עם אישור קריאה", "מחר ב-17:00".
4. **אישור קריאה:** עדכון עם "חובה לקרוא ולאשר". אצל מיכל "קראתי". במסך הניהול רואים מי אישר. "+3 שעות": תזכורת רק למי שלא אישר.
5. **שיבוץ בטקסט חופשי:** "דני בגפן היום עד הצהריים" ← אשר. דני מקבל תדריך קצר ליחידה החדשה, ואחרי 12:00 חוזר לרימון ומקבל תדריך קצר שוב.
6. **"מה עדכני?"** בכל רגע, מכל איש צוות.
7. **QR על דלת:** בטלפון "מספר חדש" לוחצים "📷 סריקת QR". הבוט שואל שם ושולח בקשה להנהלה. אחרי אישור: נהלים ותדריך נוכחי.
8. **עובד זמני:** "הוסף זמני ליאת מור 0527654321 עד 15/12 בזית". הגישה נסגרת אוטומטית בתאריך הסיום (אלה גולן מסתיימת הלילה).
9. **פרטיות:** "החניך יוסי מגפן צריך לקבל ריטלין ב-8" ← אזהרה וניסוח מוצע בלי פרטים.
10. **ביטול:** "עדכונים פעילים" ואז "בטל 6". מי שקיבל את העדכון מקבל הודעת ביטול.
11. **אירועים:** "⏭ לתדריך הבוקר הבא" מריץ את הלילה: תזכורת לאירוע ב-19:00 ערב לפני ושעתיים לפני ביום עצמו.

## How it works

| Piece | File |
|---|---|
| Data model (SQLite, one file) | `src/db.ts` |
| Units, assignments (fixed / weekday / one-off), relevance, expiry | `src/domain.ts` |
| Understanding manager text (Claude or Hebrew rules) | `src/parser.ts` |
| Bot conversation (managers and staff) | `src/bot.ts` |
| Briefings, unit switches, reminders, expiry (idempotent `tick()`) | `src/scheduler.ts` |
| 24h window handling: template nudge + outbox, or direct message | `src/messenger.ts` |
| Hebrew message rendering | `src/render.ts` |
| WhatsApp transport (simulator or Cloud API) and template list | `src/whatsapp.ts` |
| Admin screen (Hebrew, RTL, mobile) | `src/admin.ts` |
| Client-editable settings and defaults | `src/settings.ts` |

**The 24-hour window.** WhatsApp only allows free-form messages within 24 hours of the person's last message. Outside it, the bot sends one short approved template ("בוקר טוב דני, עדכונים חדשים: 2" + "הצג"), parks the content, and sends it when the person taps. The tap opens a new window, so the full content is free. Content is rendered at tap time, so cancelled or expired items never show.

**Default settings** (editable in admin → הגדרות): briefing 07:00 every day, event reminders 19:00 the evening before and 2 hours before, critical-update reminders every 3 hours up to 3 times, quiet hours 22:00–07:00 for reminders, temporary access 14 days by default.

## Tests

```bash
npm test        # scenario tests on the simulator
npm run typecheck
```

## Promo video

`promo/record.cjs` records the commercial demo from the running system (Hebrew captions, title cards, 1080p MP4):

```bash
npm start            # in one terminal
node promo/record.cjs promo/out
```

## Hosting the demo online

The repo includes a `Dockerfile` and a Render blueprint (`render.yaml`). On render.com: New → Blueprint → choose this repository. It runs one small container (Starter plan, about $7/month) with a 1 GB disk for the database, in demo mode by default. Any Docker host with a persistent volume mounted at `/data` works the same way.

## Going live (later phase)

1. Meta Business verification and a dedicated phone number (start early: can take days to weeks).
2. Submit the templates in `TEMPLATES` (`src/whatsapp.ts`) in Hebrew (`he`).
3. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_DISPLAY_NUMBER`, `DEMO=0`, and point the Meta webhook at `/webhook`.
4. Host as one small container with a persistent volume for `data/` and continuous backups (e.g. Litestream).

See `.env.example`.

## Privacy notes

- Update text is minimal by design; the bot flags health, welfare or legal details about a child and offers a neutral rewrite.
- QR codes on doors never expose content to unknown numbers: an unknown number can only request to join, and a manager approves.
- Message content passes through Meta (WhatsApp) and, when enabled, Anthropic (Claude) for understanding manager text. Staff phone numbers are never sent to the model.
- WhatsApp messages cannot be recalled once delivered; corrections go out as cancellation notices.
