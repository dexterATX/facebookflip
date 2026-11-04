# FlipRadar

**See new Facebook Marketplace listings within minutes of posting, with a photo alert on your phone.**

FlipRadar watches the Marketplace searches you care about, newest first, and pings you as soon as something new shows up, so you can message the seller before anyone else does.

<p align="center">
  <img src="docs/screenshot-desktop.jpg" alt="FlipRadar dashboard with live listings" width="74%">
  <img src="docs/screenshot-phone.jpg" alt="FlipRadar on a phone" width="22%">
</p>

## What it does

- **Fast.** Each search is checked every 3 minutes by default (you can pick 1 to 60). New listings reach your phone a few seconds after the check that finds them.
- **Phone alerts.** Free [ntfy](https://ntfy.sh) app (no sign-up), Discord or Telegram. Each alert shows the price, title, photo and how long ago it was posted, and opens the listing when tapped.
- **Smart filters.**
  - Skips listings with words you don't want ("broken", "for parts", "ISO"…), with one click to add common junk words.
  - Hides "$1, message me" bait listings. Free items still show.
  - Ignores old listings that Facebook bumps back to the top. It reads each listing's real posting time.
  - Never alerts twice for the same listing, even if two searches find it.
- **Deal spotting.** Compares each price with *similar* listings it has seen in that search. A $40 PS5 controller is compared with other controllers, not with $400 consoles. It flags steals and price drops, and can alert you **only** on deals if you prefer.
- **Gentle on Facebook.** It runs one check at a time with randomized timing, backs off automatically, and pauses everything if Facebook pushes back instead of hammering it. Optional quiet hours overnight.
- **Clean dashboard.** A live feed with photos, Saved and Deals tabs, and an activity log. It works on your phone too.

## Try it in 1 minute without Facebook

There's a demo with a pretend Marketplace that posts new fake listings every 20–60 seconds:

```bash
npm install
```

```bash
npm run demo
```

Then open http://localhost:3000.

## Set it up for real

You need a computer that stays on while you want alerts. Your everyday Windows or Mac computer is fine. **Use your home internet:** Facebook usually blocks cloud servers.

1. **Install Node.js.** Download the "LTS" version from https://nodejs.org and install it.
2. **Download FlipRadar.** On GitHub, click **Code → Download ZIP**, then unzip it.
3. **Start it.**
   - **Windows:** double-click `start.bat`.
   - **Mac:** double-click `start.command`. If macOS says it's from an unidentified developer, right-click it → **Open**.
   - **Anything else:** run `npm install` once, then `npm start`.

   Your browser opens http://localhost:3000. Keep the black terminal window open; closing it stops FlipRadar.
4. **Add a watch.** Click **New watch**. The easiest way: on Facebook, search Marketplace with your location and filters, copy the address bar, and paste it in. Or just type what you want, your city, and a price range.
5. **Turn on phone alerts.** Click the settings icon (top right) and follow the three ntfy steps, then tap **Send test**.

That's it. New listings appear on the dashboard and on your phone.

## How fast is "fast"?

How quickly you hear about a listing depends on three things:

1. **How long Facebook takes to show it in search.** Usually quick, sometimes a few minutes. No tool can beat this part.
2. **When the next check runs.** With the default 3-minute interval, that's 0–3½ minutes, about 1½ minutes on average.
3. **Delivery to your phone.** A few seconds.

So expect most alerts within about **1–5 minutes** of a listing appearing. A 1–2 minute interval gets you there sooner, at a higher chance of Facebook slowing you down. The meter under your watches shows your total checks per hour: **Gentle** (≤60), **Moderate** (≤120) or **Heavy**.

## Facebook access, honestly

Facebook has **no public Marketplace API** (official way for apps to request data). FlipRadar reads the same search page your browser does. That means:

- **Fast mode (default) needs no login.** It loads the public search page like a logged-out visitor. It works best from a home internet connection.
- **If Facebook starts asking for a login,** you'll see a yellow banner. Click **Connect Facebook**. A browser window opens; log in once and it closes by itself. The login is saved only on your computer, in `data/browser-profile`. From then on, FlipRadar uses a real background browser when fast mode is blocked (**Auto** mode).
- **Use a spare Facebook account if you can.** Facebook's terms don't allow automated collection. The realistic risk is that Facebook limits or locks the account you connect. Logged-out fast mode doesn't involve an account. Gentle check speeds keep the risk low.
- **Facebook changes its website often.** If something breaks, the watch shows a warning, and the **Activity** log (pulse icon, top right) says exactly what happened. FlipRadar doesn't depend on one fixed page layout: it searches the page data for anything shaped like a listing. That makes it more resistant to Facebook's changes than most scrapers.

**Servers and Docker:** these have no screen for the login window. Use **Settings → Facebook connection → Advanced: paste cookies** instead. Export your facebook.com cookies with a cookie-export browser extension and paste them there.

## Phone alerts

| Option | Setup | Notes |
| --- | --- | --- |
| **ntfy** (recommended) | Install the free ntfy app ([iPhone](https://apps.apple.com/app/ntfy/id1625396347), [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy)), tap **+**, subscribe to the topic shown in Settings. | No account. Shows photos. Your topic name works like a password, so keep it private. |
| **Discord** | Channel settings → Integrations → Webhooks → New webhook → copy the URL into Settings. | Nice for sharing with a partner or team. |
| **Telegram** | Message **@BotFather** → `/newbot` → copy the token. Get your chat ID from **@userinfobot**. | |

While the dashboard is open, it also plays a sound and can show desktop notifications (Settings → This browser).

## Running it all the time

- **Simplest:** leave your computer on with the FlipRadar window open. Turn off sleep in your power settings.
- **Docker / Raspberry Pi (64-bit):**

  ```bash
  docker compose up -d --build
  ```

  Then open http://localhost:3000 on that machine. Edit `docker-compose.yml` to set your time zone. To open it from your phone on the same Wi-Fi, set a `PASSWORD` and change the port line as the comments there explain.

## Settings you can change when starting

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Dashboard port. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to allow other devices on your network (set `PASSWORD` too). |
| `PASSWORD` | none | Password-protect the dashboard. |
| `DATA_DIR` | `./data` | Where settings, listings and the browser login are stored. |
| `BROWSER_PATH` | auto | Full path to Chrome/Edge/Chromium if it isn't found automatically. |
| `FB_USER_AGENT` | recent Chrome | Browser identity string used in fast mode. |

## Troubleshooting

- **"Facebook wants a login"**: click **Connect Facebook** in the banner (or paste cookies on a server).
- **"Location not recognized"**: edit the watch and paste a Marketplace search link instead of typing the city.
- **"Empty page from Facebook"**: this happens now and then. FlipRadar retries automatically. If it keeps happening, switch Settings → Facebook connection to **Auto** or **Browser only**.
- **"No browser found"**: install Google Chrome, or run `npm run setup-browser` to download Chromium.
- **"Port 3000 is already in use"**: FlipRadar is probably already running. Otherwise start it with `PORT=3001`.
- **No phone alerts**: open Settings and tap **Send test**. Any error shows next to the channel name.

## How it works (for the curious)

- **Search:** every watch becomes a Marketplace search link forced to *Date listed: newest first* and *last 24 hours*, so new posts are always on page one.
- **Reading listings:** Facebook embeds the first page of results as JSON (structured data) inside the page. Instead of trusting one fixed path through that data, FlipRadar walks all of it and keeps every object shaped like a listing: one with an `id` and a `marketplace_listing_title`. It skips sponsored stories. In browser mode, it also reads Facebook's own data responses, and as a last resort the visible listing cards. See `src/facebook/extract.js`.
- **Fast mode** sends the same headers Chrome sends when opening a page, and keeps Facebook's guest cookie like a returning visitor (`src/facebook/http.js`). **Browser mode** drives your installed Chrome or Edge with its own profile (`src/facebook/browser.js`).
- **New vs. old:** the first check of a watch is a quiet baseline. After that, a listing alerts if FlipRadar hasn't seen it before *and* it was posted within your alert window, 60 minutes by default (`src/monitor.js`).
- **Deals:** the median price of similar listings (shared title words) from that watch over 14 days (`src/deals.js`).

```text
src/
  server.js          web server, JSON API, live updates (Server-Sent Events)
  monitor.js         scheduler: timing, backoff, new-listing detection, alerts
  deals.js           filters and deal scoring
  notify.js          ntfy, Discord, Telegram
  store.js           saves everything to data/db.json
  facebook/          links, page reading, fast mode, browser mode
public/              the dashboard (plain HTML, CSS and JavaScript)
tools/               pretend Marketplace + demo
test/                automated tests
```

Run the tests with `npm test`. They include a full run against the pretend Marketplace and, when Chrome or Chromium is installed, the real browser mode.

## Also in this repository

[Sister Protects](sister-protects/) is a separate app. It reads your Instagram screenshots and flags every place she commented, got tagged, or is named in the accounts she follows. It's one HTML file with nothing to install. See [its README](sister-protects/README.md).

---

FlipRadar is not affiliated with, endorsed by, or connected to Facebook or Meta. It's meant for personal use at reasonable speeds.
