# Sister Protects

**Find out whether she commented on, got tagged in, or is named in the Instagram accounts she follows, using screenshots you take.**

You take screenshots on Instagram. The app reads them and flags every one that shows her. Everything stays organized in one place: a checklist of accounts, and a list of findings with a copy of each screenshot.

## What it does

1. **Her.** You enter her username (and any second accounts), plus her name and nicknames.
2. **Accounts.** You screenshot her Following list as you scroll. The app reads the usernames and builds a checklist. Each account has an Open link and a status: not checked, nothing found, or found something.
3. **Scan.** You open each account and screenshot the comments under its posts, its Tagged tab, its reels and stories. Upload as many at once as you like. The app flags:
   - comments and replies she wrote
   - posts she's tagged in or co-posted
   - @mentions of her
   - "Liked by" lines with her name
   - her name, nicknames, or other words you chose (marked "Possible", because other people share names)
4. **Findings.** Each screenshot that shows her is saved with what was found and room for a note. An account is marked "found" automatically when a screenshot from it shows her username. You can copy or download a plain-text summary.

## What it can't do

- **It can't look through Instagram by itself.** Instagram gives apps no way to look up what one person commented on, and its rules don't allow automated browsing. So you take the screenshots and the app does the reading.
- **It only sees what's in your screenshots.** Private accounts you can't see and comments she deleted won't show up.
- **It reads text, not faces.** A photo of her with no name or tag won't be flagged. Keep those with "Save anyway" or "Add a screenshot by hand".
- **"Possible" isn't proof.** It means a name matched, or a username looked close (one letter off, or cut off on screen). Check those yourself.

## Two ways to run it

| | Opened in Claude (as a Claude page) | Opened anywhere else |
| --- | --- | --- |
| Who reads the screenshots | Claude. The first time, Claude asks you to allow the page. Each screenshot uses a little of your Claude usage. | A text reader that runs in your browser (Tesseract). It downloads once, about 7 MB. Screenshots never leave your device. Slower and less exact. |
| Where your work is saved | Privately in your Claude account. People you share the page with can't see it. | In that browser only. Download a backup now and then. |
| Downloads | Claude asks before saving a file. | Normal browser downloads. |

To run it outside Claude, open `index.html` in Chrome, Edge, Safari or Firefox. You can double-click it, or put it on any web host. There's nothing to install and no build step.

## Privacy

- Only screenshots that show her are kept, as small previews. Screenshots with nothing about her are dropped once you leave the page.
- In Claude, screenshots are sent to Claude to be read. Outside Claude, nothing is uploaded.
- "Clear everything" (step 1, at the bottom) deletes her usernames, the account list and all findings.

## How it works (for the curious)

- **One file.** `index.html` holds the page, styles and code. It uses no frameworks.
- **Reading with Claude.** Each screenshot goes to Claude with instructions to write down, as JSON, every caption, comment, reply, tag and "Liked by" name it can read, with who wrote it. It is told not to identify anyone from their face. Very tall screenshots are cut into slices first so the text stays readable.
- **Matching happens in the page.** Her username is compared with each comment's author and searched for in the text. Exact matches are "Found". Look-alikes are "Possible": a character or two off for longer usernames, `.` and `_` swapped, or a name cut off with "…". Names and keywords are matched as whole words. Phone numbers are matched by their digits.
- **On-device reader.** Screenshots are turned grey and dark mode is flipped to dark-on-light before reading. Tesseract tends to drop underscores (`mike_22` comes back as `mike 22`), so the page checks the gap between words for the underscore's line.
- **Saving.** In Claude, data is kept under the viewer's private `data/users/<id>/` path in the page's database. Big account lists are split across several documents. Elsewhere it uses IndexedDB.

Tests: `npm test` (from the repository root) runs `test/sister-protects.test.js` in headless Chrome. It covers the matching rules, the whole flow with a stand-in for Claude, backups, and the real on-device reader on rendered screenshots. The last one needs internet. Set `BROWSER_PATH` if Chrome isn't found automatically.

---

Sister Protects is not affiliated with, endorsed by, or connected to Instagram or Meta.
