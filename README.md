# FlipRadar

**See new Facebook Marketplace listings within minutes of posting, and get pinged only for the ones worth flipping.**

FlipRadar watches the Marketplace searches you care about, newest first. Every new listing is checked as a flip: what it resells for, what you'd make after costs, and red flags. Good deals go to your **Deals** pile and your phone. Everything else lands in an **Unsorted** pile with the reason, so a wrong call never costs you a listing.

<p align="center">
  <img src="docs/screenshot-desktop.jpg" alt="FlipRadar dashboard with live listings" width="74%">
  <img src="docs/screenshot-phone.jpg" alt="FlipRadar on a phone" width="22%">
</p>

## What it does

- **Fast.** Each search is checked every 3 minutes by default (you can pick 1 to 60). New listings reach your phone a few seconds after the check that finds them.
- **Every result, not just the first 24.** Facebook shows 24 results at a time, with a cursor (a bookmark) for the next page. FlipRadar follows that cursor with your cookies to the end of the results. See [Reading every page](#reading-every-page).
- **Your area only.** One place and distance for every search. It asks Facebook for local pickup only, and drops anything that still isn't local: listings that only ship, and ones from outside your state. See [Your area](#your-area).
- **Signs in with your cookies.** You paste your Facebook cookies once; FlipRadar keeps them fresh. No passwords, no login windows, no extra browser.
- **Phone alerts.** Free [ntfy](https://ntfy.sh) app (no sign-up), Discord or Telegram. Each alert shows the price, title, photo and how long ago it was posted, and opens the listing when tapped.
- **Smart filters.**
  - Skips listings with words you don't want ("broken", "for parts", "ISO"…), with one click to add common junk words.
  - Hides "$1, message me" bait listings. Free items still show.
  - Ignores old listings that Facebook bumps back to the top. It reads each listing's real posting time.
  - Never alerts twice for the same listing, even if two searches find it.
- **Deal checking.** Every listing gets an estimated resale price, profit and margin, plus a plain reason. Possible deals get a closer look at the full listing before you're alerted. See [How it decides what's a deal](#how-it-decides-whats-a-deal).
- **Built-in price guide.** Recent used sale prices for 35 popular flips (PlayStation, Xbox, Switch, Steam Deck, Meta Quest, iPhone 13–16, Galaxy S24 Ultra, iPad, AirPods Max), each with its source and date. Those items can be judged from the very first listing, with no price history needed.
- **Two piles, nothing lost.** **Deals** alert you. **Unsorted** keeps everything else with its reason, like "only +$12 profit" or "for parts (doesn't turn on)". 👍/👎 any listing to move it, and FlipRadar keeps score of how often it was right.
- **Good deals are saved for you.** Every deal goes to the **Saved** tab automatically and stays until you un-star it, even after it's gone from Facebook. (The app keeps your newest 1,000 deals; anything you star yourself is never trimmed.) Each deal is also written to a spreadsheet, `data/deals.csv`, that keeps every one: price, what it resells for, profit, where the price came from, and the link. Download it from the Deals or Saved tab and open it in Excel, Google Sheets or LibreOffice.
- **Optional AI second opinion.** With your own Anthropic API key, Claude identifies the exact item, reads the condition and photo, and estimates what it really sells for. It only checks possible deals, with a daily cap.
- **Gentle on Facebook.** It runs one check at a time with randomized timing, backs off automatically, and pauses everything if Facebook pushes back instead of hammering it. Optional quiet hours overnight.
- **Clean dashboard.** A live feed with photos, Deals / Unsorted / Saved tabs, a "why?" breakdown on every listing, and an activity log. It works on your phone too.

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
4. **Paste your Facebook cookies.** Click **Add cookies** in the yellow banner (or the settings icon, top right) and follow the three steps. See [Facebook cookies](#facebook-cookies).
5. **Set your area.** Settings → **Your area**: paste a Marketplace link with your location and distance set, or type your city.
6. **Add a watch.** Click **New watch** and type what you want and a price range. It searches your area.
7. **Turn on phone alerts.** Settings → follow the three ntfy steps, then tap **Send test**.

That's it. New listings appear on the dashboard and on your phone.

## How it decides what's a deal

<p align="center"><img src="docs/screenshot-deal-check.jpg" alt="The deal check for one listing: resale estimate, profit math, reasons and the seller's description" width="70%"></p>

Resellers judge a flip by what an item actually **sells** for, minus every cost. FlipRadar does the same, in four steps:

1. **Red flags first.** "For parts", "doesn't turn on", iCloud-locked, "ISO"/wanted posts, replicas, rentals and payment plans, box-only listings, and scam wording (deposits, "shipping only", "pay first", "Zelle only"). Negations don't count: "not broken" and "no scratches" are fine.
2. **What it resells for.** In order of trust:
   - **Your number.** Set "Resells for about" on a watch, and FlipRadar uses it. Exceptions: if the item is clearly something cheaper (a PS4 Pro in a PS5 search, per the price guide) or similar listings sell for far less (a $45 controller), it trusts those instead.
   - **The price guide.** For the [popular items it knows](#the-price-guide), what they actually sold for used, recently. It's strict about matching: "PS5 controller", "case for iPhone 15" and "iPhone 16e" get no guide price.
   - **Similar listings.** FlipRadar remembers 30 days of prices. It compares each listing with ones whose titles share real words beyond your search words, so controllers are compared with controllers, not consoles. Marketplace prices are *asking* prices, so it assumes items sell for 90% of asking (adjustable).
   - **Both together.** When local listings agree with the guide, the call is high confidence. When they disagree, FlipRadar uses the **lower** number. Local prices are often lower than national ones, and that's what you'll actually get.
   - **The optional AI**, cross-checked against the above. When the AI disagrees, FlipRadar uses the lower number and marks the call less certain.
   - **Condition.** A seller-listed "Used – fair" counts 15% lower, "poor" 30% lower. That's a rule of thumb, not data. Listings missing what normally comes with the item ("no controller", "tablet only") are marked less certain.
3. **Profit.** Resale − asking price − selling fees − your other costs (gas, cleaning, time; $10 by default). Selling locally has no fees. eBay is counted at 13.6% + $0.40 per sale + the shipping you enter. Published 2026 figures range from 12.9% to 13.6%, so check your own fees in eBay Seller Hub.
4. **Verdict.** It's a **deal** only if the profit is at least $40 **and** at least 25% of the resale price, nothing blocks it, and the estimate is at least medium confidence. All of these are adjustable in Settings. Anything unsure goes to **Unsorted** with the reason.

**Before alerting about a possible deal**, FlipRadar opens the full listing to read the description and condition, since problems often show up only there. With the AI on, Claude takes a look too. Deal alerts go out right after, usually within seconds.

**Too good to be true?** These count as likely scams and never alert:

- a price under about 12% of resale value;
- a deposit, "pay first" or "shipping only" request on anything priced like a deal (under 65% of resale);
- "Zelle / Cash App only" at under 40% of resale. (Payment apps alone are normal with honest sellers.)

Between 12% and 25% of resale it can still be a deal, with a "see it in person before paying" warning. If something is far under *your* resale price or the guide price and no local listings confirm it's the same item, it goes to Unsorted as "check it is the same item".

**How accurate is it?** It's a careful estimate, not a guarantee:

- **Items in the price guide** can be judged from the first listing. For everything else, there's little price history on day one, so expect more "not enough price info" in Unsorted. It gets sharper as listings come in.
- For the most accurate calls on other items, give each watch a "resells for" price, or turn on the AI.
- **A labeled test set** of 71 realistic listings (deals, fair prices, accessories, broken and locked items, scams, missing parts, unknown models) checks the rules. Run `npm run accuracy` for the report. Currently: 70 of 71 right, **0 false alarms**, 1 missed deal on purpose (a PS5 sold without its controller, kept in Unsorted because it's worth less than a complete one). These are hand-written examples, so they show the rules work as designed, not real-world accuracy.
- Use 👍/👎 on listings. FlipRadar shows how often its deals were right, so you can see whether to tighten your rules.

### The price guide

Used sale prices collected **November 4, 2026**, stored with their sources in [`src/data/price-guide.json`](src/data/price-guide.json). Settings → Deal rules has the full list and an on/off switch.

| Items | Source | Price used |
| --- | --- | --- |
| PlayStation 5 (original, Slim, Pro), PlayStation 4 (original, Slim, Pro), Xbox Series X and S, Nintendo Switch (original, OLED, Lite, Switch 2) | [PriceCharting](https://www.pricecharting.com/) | "Loose" (used, no box), from completed eBay sales |
| iPhone 13–16 (base, Pro, Pro Max), Galaxy S24 Ultra, Steam Deck (LCD, OLED), Meta Quest 2 / 3 / 3S, iPad 9th and 10th gen, AirPods Max | [Swappa](https://swappa.com/prices) | Average sale price, base storage size |

Good to know:

- **Prices are national, online sale prices.** Local Marketplace prices are often lower; when local listings disagree, the lower number wins.
- **Base storage only** for phones and tablets, so bigger sizes are underestimated. That's the safe direction.
- **PS5 Pro** used prices were unusually high and jumpy in late 2026, so the guide alone never makes a PS5 Pro a deal: local listings have to agree.
- **Not covered yet:** MacBooks, AirPods Pro, game controllers, graphics cards, Dyson, KitchenAid and anything else. Those use your own number, similar listings, or the AI.
- **Prices drift.** After 6 months the guide counts as old and can't trigger an alert on its own. To refresh it, update the `price` numbers and `asOf` date in the file from the source links, then restart.

### AI second opinion (optional)

Settings → **AI second opinion**: paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys), switch it on, and tap **Test the AI**.

- **Which model.** Claude Opus 5.5 is the default and most accurate (about 3¢ per check). Sonnet 5.5 costs about 1–2¢ and Haiku 5.5 about 0.1¢.
- **Cost control.** Only possible deals are checked, and there's a daily cap (60 by default). Today's spend shows in Settings.
- **Refusals.** If the model declines a request for policy reasons, Anthropic retries it on its recommended fallback model.

## How fast is "fast"?

How quickly you hear about a listing depends on three things:

1. **How long Facebook takes to show it in search.** Usually quick, sometimes a few minutes. No tool can beat this part.
2. **When the next check runs.** With the default 3-minute interval, that's 0–3½ minutes, about 1½ minutes on average.
3. **Delivery to your phone.** A few seconds.

So expect most alerts within about **1–5 minutes** of a listing appearing. A 1–2 minute interval gets you there sooner, at a higher chance of Facebook slowing you down. The meter under your watches shows your total checks per hour: **Gentle** (≤60), **Moderate** (≤120) or **Heavy**.

## Reading every page

Facebook puts the first 24 results in the search page, along with a cursor: a bookmark for where they end. When you scroll, Facebook's own page code sends that cursor back and gets the next 24 and a new cursor, until there are no more. FlipRadar does exactly that, with plain web requests and your cookies, so it's light and quick: about a second or two per page, with a short pause between pages like someone scrolling.

Every check reads page 1 first and sends its alerts right away. Then it follows the cursor:

- **To the very end:** on a search's first check, when you press "Check now", and every 10 minutes, to catch listings Facebook placed lower (its "newest first" order isn't strict).
- **Right away on a burst:** when most of page 1 is new, more new ones are almost certainly on the next pages.
- **Routine checks** stop as soon as a page brings nothing new, to stay gentle.

A search whose results all fit on page 1 never asks for more. The limit is in Settings → Smart alert rules → **Results to read per search** (default: all of them).

**How it asks for the next page.** The request needs the id of Facebook's "next page" query, which changes when Facebook updates its site. FlipRadar uses the one that worked last time; if that stops working, the id of the query the search page itself ran; and if that doesn't take a cursor, it finds the id in Facebook's own script files. The **Activity** log shows which one it used. If none work (Facebook changed something bigger) and Chrome or Chromium is installed, it scrolls the search in a hidden browser with the same cookies instead. If that isn't possible either, it reads page 1, and the watch says "first page only".

## Your area

Settings → **Your area** sets one place and distance for every search.

- **Place:** paste a Marketplace link (the most exact way: on Facebook, open Marketplace, click your location, pick it and a distance, search for anything, and copy the address bar; FlipRadar takes the place and the distance from it), or type your city.
- **Distance:** Facebook's default for your place, or 1 to 500 miles.
- **Local pickup only** (on by default): asks Facebook for local pickup, and drops listings that only ship.
- **Only these states:** listings from other states are dropped. FlipRadar fills this in from the first results in your area when nearly all of them are in one state, and again if you move your area somewhere else. Near a state line, list both (like `FL, GA`) or leave it empty; what you type stays.

A watch can still name a city of its own. It searches there, still local pickup only, and isn't held to your state(s).

Dropped listings never show up, never alert and don't count as price comparisons. The Activity log counts them ("12 not local, skipped"). Changing your area hides stored listings that no longer fit; anything you starred yourself stays.

## Facebook cookies

FlipRadar signs in to Facebook with your cookies (small files your browser keeps that say you're logged in). Nothing touches Facebook until they're in.

1. On this computer, open **facebook.com** in Firefox or Chrome, logged in. A spare account is safest.
2. Add the free **Cookie-Editor** extension, open it while on facebook.com, and click **Export**. That copies the cookies.
3. In FlipRadar, Settings → **Facebook cookies**: paste them and press **Save cookies**. It checks your watches right away and shows whose account it's using.

- **They stay only on this computer**, in `data/db.json`. FlipRadar keeps them fresh as Facebook updates them, like a browser does.
- **When they stop working** (they expire, or you log out of Facebook in that browser), FlipRadar says so in a banner and waits for fresh ones instead of retrying.
- **Honest heads-up:** Facebook's terms don't allow automated checking. The realistic risk is that Facebook limits or locks the account. A spare account and gentle check speeds keep that risk low.
- **Facebook changes its website often.** If something breaks, the watch shows a warning and the **Activity** log (pulse icon, top right) says what happened. FlipRadar doesn't depend on one fixed page layout: it searches the page data for anything shaped like a listing.

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
| `DATA_DIR` | `./data` | Where settings, your cookies, listings, your deals spreadsheet (`deals.csv`) and the background browser's cache are stored. |
| `BROWSER_PATH` | auto | Chrome/Edge/Chromium for the optional backup way of reading more pages. |
| `FB_USER_AGENT` | recent Chrome | The browser identity FlipRadar's requests use. |

## Troubleshooting

- **"Location not recognized"**: in Settings → Your area, paste a Marketplace link instead of typing the city.
- **"Empty page from Facebook"**: this happens now and then. FlipRadar retries automatically. If it keeps happening, paste fresh cookies.
- **"Add your Facebook cookies" / "didn't accept your cookies"**: export fresh ones from facebook.com and paste them in Settings → Facebook cookies.
- **"First page only"** on a watch: FlipRadar couldn't follow Facebook's cursor that time (the Activity log says why) and tries again in 30 minutes. Installing Google Chrome, or running `npm run setup-browser`, gives it a backup way.
- **"Port 3000 is already in use"**: FlipRadar is probably already running. Otherwise start it with `PORT=3001`.
- **No phone alerts**: open Settings and tap **Send test**. Any error shows next to the channel name.

## How it works (for the curious)

- **Search:** every watch becomes a Marketplace search link forced to *Date listed: newest first* and *last 24 hours*, so new posts are always on page one.
- **Reading listings:** Facebook embeds the first page of results (24) as JSON (structured data) inside the page, and loads the rest with its own data requests as you scroll. Instead of trusting one fixed path through that data, FlipRadar walks all of it and keeps every object shaped like a listing: one with an `id` and a `marketplace_listing_title`. It skips sponsored stories. When it falls back to scrolling in the background browser, it reads Facebook's data responses there too, and as a last resort the visible listing cards. See `src/facebook/extract.js`.
- **When to read more pages:** `morePlan` and `readMore` in `src/monitor.js` decide when following the cursor is worth it, and add what turns up.
- **Requests** send the same headers Chrome sends, with your cookies, and keep the cookies Facebook updates (`src/facebook/http.js`, `src/facebook/client.js`).
- **Following the cursor:** `src/facebook/paging.js` reads the session tokens, the page's own query and the cursor from page 1, builds the same next-page request Facebook's page code sends to `/api/graphql/`, and reads each answer. The backup way, scrolling in a hidden browser with the same cookies, is `src/facebook/browser.js`.
- **Your area:** `src/area.js` decides what's local; the search links ask Facebook for local pickup (`src/facebook/urls.js`).
- **New vs. old:** the first check of a watch is a quiet baseline. After that, a listing alerts if FlipRadar hasn't seen it before *and* it was posted within your alert window, 60 minutes by default (`src/monitor.js`).
- **Deals:** red flags, resale estimate, profit math and the verdict live in `src/evaluate.js`. The price guide matcher is `src/priceguide.js`. The closer look (full listing, then AI) runs in `src/monitor.js`, and the optional AI is in `src/ai.js`.

```text
src/
  server.js          web server, JSON API, live updates (Server-Sent Events)
  monitor.js         scheduler: timing, backoff, new-listing detection, alerts
  evaluate.js        the deal check: red flags, resale estimate, profit, verdict
  priceguide.js      matches a listing to the price guide (strictly)
  data/              price-guide.json: used sale prices, sources, dates
  ai.js              optional AI second opinion (Claude)
  deals.js           your filters and text helpers
  notify.js          ntfy, Discord, Telegram
  store.js           saves everything to data/db.json; deals also go to data/deals.csv
  area.js            your area: what counts as local
  facebook/          links, page reading, cookies, following the cursor
public/              the dashboard (plain HTML, CSS and JavaScript)
tools/               pretend Marketplace, demo, accuracy report
test/                automated tests; fixtures/ holds the labeled test set
```

Run the tests with `npm test`. They include a full run against the pretend Marketplace, the labeled accuracy set, and, when Chrome or Chromium is installed, the background-browser fallback. `npm run accuracy` prints the accuracy report.

---

FlipRadar is not affiliated with, endorsed by, or connected to Facebook or Meta. It's meant for personal use at reasonable speeds.
