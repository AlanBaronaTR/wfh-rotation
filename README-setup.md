# WFH Rotation — publish + share setup

## What changed in index.html
- `exportState()` / `applyState()` — split out of the old save/load code, no behavior change.
- `bootAndRender()` — on page load, fetches `./data.json` (if present) as the shared baseline, then
  overlays your own browser's local edits on top, then renders. If `data.json` doesn't exist yet
  (e.g. first run), it just falls back to what's already in the file / your local browser storage.
- **Publish** button (next to Copy for Teams) — downloads a `data.json` file containing the full
  current schedule state. That's the file you commit to the repo to make your changes visible to
  everyone else.

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
2. Click **Publish** — this downloads `data.json`.
3. Move that `data.json` into your repo folder (replacing the old one) and commit + push:
   ```
   git add data.json
   git commit -m "Update rotation"
   git push
   ```
4. GitHub Pages redeploys automatically; everyone's next page load shows the update.

## Note on local testing
If you open `index.html` directly from disk (`file://`), the browser will usually block the
`fetch('./data.json')` call due to local file security rules — it'll just silently fall back, which
is fine. To test the fetch for real, either push to GitHub Pages, or run a tiny local server first:
```
python3 -m http.server 8000
```
then visit `http://localhost:8000/`.
