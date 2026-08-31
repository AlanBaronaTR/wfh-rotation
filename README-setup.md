# WFH Rotation — publish + share setup

## What changed in index.html
- `exportState()` / `applyState()` — split out of the old save/load code, no behavior change.
- `bootAndRender()` — on page load, fetches `./data.json` (if present) as the shared baseline, then
  overlays your own browser's local edits on top, then renders. If `data.json` doesn't exist yet
  (e.g. first run), it just falls back to what's already in the file / your local browser storage.
- **Publish** button (next to Copy for Teams) — prompts for an optional short note describing what
  changed, then downloads a `data.json` file containing the full current schedule state, a fresh
  `publishedAt` timestamp, and a rolling changelog of the last 20 publishes. That's the file you
  commit to the repo to make your changes visible to everyone else.
- **Last published** timestamp shown near the top of the page (both Weekly and Monthly views), so
  anyone viewing the live dashboard can tell how fresh the data is.
- **Unpublished-changes banner** — if your browser's local edits differ from what's in the
  currently-loaded `data.json`, a small banner reminds you to click Publish and push `data.json`
  before you lose track of what's changed locally.
- **Recent changes** — a collapsible section (bottom of the Weekly view) listing the last 20 publish
  notes with timestamps, so you don't have to dig through git history to see what happened recently.

## How sharing works
There's no login system here — it's a static page. The real permission boundary is **who has push
access to the git repo**: you edit locally, click Publish, commit the new `data.json`, push. Anyone
who opens the page (via GitHub Pages) always sees whatever `data.json` is currently in the repo.
If someone opens the page and clicks around, it only changes their own browser's local view — it
never touches the shared file unless they also have push access and commit their own `data.json`.
That's the natural way to later add editors: give them repo write access.

## One-time setup
1. Create a repo (ask about your org's GitHub Enterprise if this needs to live inside TR).
2. Add `index.html` to the repo root (rename is fine, GitHub Pages looks for `index.html` by default).
3. Repo → Settings → Pages → Deploy from branch → pick `main` / root. Save.
4. You'll get a URL like `https://<org>.github.io/<repo>/` within a minute or two. Share that link.

## Weekly workflow
1. Open `index.html` locally (double-click it, or open via a local server) and edit the schedule as usual.
2. **Before publishing, run the smoke test** — see below. Do not proceed if it fails.
3. Click **Publish** — you'll be prompted for an optional short note (e.g. "swapped Karen/Mafer for
   next week"), then it downloads `data.json`.
4. Move that `data.json` into your repo folder (replacing the old one) and commit + push:
   ```
   git add data.json
   git commit -m "Update rotation"
   git push
   ```
5. GitHub Pages redeploys automatically; everyone's next page load shows the update.

## Before every publish/push: run the smoke test
`test-smoke.js` is a small, dependency-free Node script that loads the real script out of
`index.html` and exercises it without a browser — the holiday 3-state cell cycle, the office-day
mandate math, the Excel/Sheet/Teams export builders, and the publish/changelog/unpublished-changes
logic. It also does a static check that every function referenced via `onclick=`/`onchange=` in the
rendered HTML actually exists in the file — this is exactly the bug class that shipped once already
(a button wired up to a function that was never defined). Run it any time you edit `index.html`,
and always right before you click Publish / push:
```
node test-smoke.js
```
It prints a pass/fail count and exits non-zero on any failure — don't publish or push if it's red.

## Note on local testing
If you open `index.html` directly from disk (`file://`), the browser will usually block the
`fetch('./data.json')` call due to local file security rules — it'll just silently fall back, which
is fine. To test the fetch for real, either push to GitHub Pages, or run a tiny local server first:
```
python3 -m http.server 8000
```
then visit `http://localhost:8000/`.
