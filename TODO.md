# wfh-rotation — work queue

Working file for Claude Code. Drop this in the repo root.

**How to use:** point Claude Code at this file (`work through TODO.md`, or name a
single item). Work in priority order. Tick a box only when the change is committed
and `node test-smoke.js` is green. Add a smoke test for every fix —
`test-smoke.js` currently covers none of `renderWeekGrid`'s output values.

**Repo shape:** single-file vanilla JS app (`index.html`, ~1215 lines) +
`data.json` + `test-smoke.js`, deployed to GitHub Pages. No build step.

**Line numbers below are from commit `26fa3b3`.** Re-verify before editing —
don't trust them blindly.

---

## Constraints (apply to everything)

- Single self-contained HTML file, no build step, no new runtime dependencies.
- Don't reformat code you aren't changing.
- Ask before any change that alters `data.json`'s shape.

---

## P0 — Data loss

Nothing else ships before these.

### - [x] 2. Navigating to a week silently destroys published data

`getSched(o)` (~L366) lazily creates an all-`'off'` week; `render()` ends with
`saveState()` (~L960) persisting it; on next boot `bootAndRender` (~L361) runs
`applyState(remote)` **before** `loadState()`, and `applyState`'s `Object.assign`
on `schedule` (~L205) lets the local empty skeleton replace a colleague's real
published week. `dataFingerprint()` (~L216) excludes all-`'off'` weeks, so the
unpublished-changes banner stays silent and the next Publish exports the emptied
week over theirs.

- [x] Write a **failing test reproducing the overwrite** before fixing.
- [x] Don't persist lazily-created empty weeks.
- [x] ~~Make the remote/local merge per-week, on real edits only.~~ Not needed:
      since a lazily-created week is never persisted at all now, `applyState`'s
      existing whole-object merge never sees a stale skeleton to begin with.

Fixed 2026-08-31: `exportState()`'s `schedule` field now goes through
`normalizedScheduleForFingerprint()` (already used for the unpublished-changes
banner) instead of the raw live object, so an all-`'off'` week that's only ever
been viewed — never edited — is never saved or published.

### - [x] 3. Unlocking a week never survives a reload

`lockedWeeks` in `applyState` (~L205) is add-only. Make lock state authoritative
from the published file.

Fixed 2026-08-31: `applyState`'s `lockedWeeks` handling now replaces the Set
wholesale (`lockedWeeks=new Set(state.lockedWeeks)`), same as `vacationLog`/
`MEMBERS`, instead of only ever adding to it. Remote sets the baseline; local
(if present) authoritatively overrides it with this browser's own saved state.

### - [x] 4. `buildSuggestion` erases leave for next week

`buildSuggestion` (~L425, L458) initialises the whole next week to `'off'` for
every member and assigns it wholesale, wiping any `vacation`/`sick`/`otherteam`
already stamped there from the vacation log — after which the log and the grid
disagree. Preserve non-`'off'`/`'wfh'` states. Same for `regenSuggestion` (~L460).

Fixed 2026-08-31: `buildSuggestion` now reads whatever's already in
`schedule[wkKey(next)]` and carries forward any day already committed as
`vacation`/`sick`/`otherteam`, excluding it from the WFH-candidate pool and
the always-office desk count. `regenSuggestion` no longer deletes the week
outright before re-rolling — it just re-runs `buildSuggestion`, which now
preserves real commitments while still re-randomizing the WFH picks.

---

## P1 — Correctness

### - [ ] 5. `mOff2` hoisting bug — monthly column always renders 0/0

Used at L1007, declared at L1033. Hoisting makes it `undefined`, so
`getMonthWeekOffsets(undefined)` returns `[]` and the per-member monthly column
at L1009 renders `0/0` for everyone. Move the declaration above the loop.

Also: `mOff2 = curMonth - tmpD.getMonth()` ignores the year and clamps to
±6 months, so the same calendar month in a different year resolves wrongly.

### - [ ] 6. html2canvas is loaded but never called; the Teams panel lies

- CDN tag at L52, `html2canvas` appears nowhere else in the file.
- `function doDownload(){}` at L547 — empty, never referenced.
- L1147 tells users it copies an image and falls back to a PNG download.
- `copyTeamsImage()` (L465) only calls `selectNodeContents`, and the button
  label ("Select for copy" / "Press Ctrl+C") contradicts the help text directly
  above it.

Make it actually produce a PNG to the clipboard with a real download fallback,
or remove the CDN script and fix the copy. Prefer: make it work.

### - [ ] 7. WFH day count ratchets up and never comes back down

`buildSuggestion` L438: `n2 = Math.max(wfhTarget, cw.length)`. Once someone hits
3 WFH days they never return to 2 and stay permanently below the 3-day office
mandate. Cap at `wfhTarget` unless leave or holidays genuinely reduce their
available days.

### - [ ] 8. Hardcoded timezone strings drift

`SHIFTS` (L90-98) hardcodes `et:` and `ist:` label strings for all nine bands.
Mexico has no DST, the US and India differ — these are wrong roughly eight months
a year, and every exporter (`buildTSV`, `buildSheetTSV`, `buildSheetHTML`,
`buildTeamsHTML`) consumes them verbatim. Compute from a base MX local time and
the real UTC offset for the week being rendered.

### - [ ] 9. `'otherteam'` missed in two places

Handled correctly nearly everywhere, but:

- `renderMonthView` L1205 omits it from the office-day count, so the month view
  shows a false amber/red compliance badge contradicting the monthly total from
  the four mandate functions.
- `isScheduled` L369 counts only `'wfh'` as planned, so an all-`otherteam` week
  reads as unplanned and drives the wrong "next week has no rotation" state.
- `vacLabel` (L627) doesn't branch on type, so an other-team entry reads
  identically to a vacation entry in the log — even though `removeVacation`
  (L515) does branch.

### - [ ] 10. `hasNote()` can never return true — dead feature

Reads `notes['note_<wk>_<id>']`, but the only writers use `dn_<wk>_<id>_<d>`
(L670) and `note_week_<wk>` (L1015). So the note dot at L980 and the per-member
note in the export card at L1160 never render. Wire the key up or delete it.

### - [ ] 11. No HTML escaping anywhere

~30 `innerHTML` assignments concatenate member names, nicks, holiday names and
free-text note content. Add an `escapeHtml` helper and apply it — particularly
`addHoliday` (L419), the day-note renderer, and `manageTeamHTML` (L868).

### - [ ] 12. No schema version or migration mechanism

Add a `schemaVersion` field plus a real migration path. Today `migrateShift`
(L108) is the only migration, and `hiddenMembers` → `hiddenByWeek` is detected
by presence-sniffing inside `applyState`.

### - [ ] 13. Dead / misleading config

Comments at L221-223 document an `EDIT_MODE` true/false switch that doesn't
exist as a variable. `REMOTE_LOADED` is set at L358 and never read. Remove or
implement.

---

## P2 — Automation

### - [ ] 14. Deterministic rotation instead of `Math.random()`

Replace the shuffles at L444, L445 and L453 with a ledger of per-person,
per-weekday WFH counts, always picking the least-used. Two reasons:
`sort(() => Math.random()-0.5)` is not a uniform shuffle, and the rotation needs
to be defensible when someone asks why they got Monday again. It should be
reproducible from schedule history alone.

L453 also re-sorts the array in place on every `while` iteration just to read
element `[0]`.

### - [ ] 15. Automate the publish loop

Today: click Publish → download `data.json` → move into repo → commit → push.

Replace with a single local command that runs the smoke test, validates
`data.json` against a schema, copies it into place, commits and pushes —
refusing to proceed if the test is red.

**Do not put credentials in the page or in Actions: the repo is public.**

### - [ ] 16. CI

GitHub Actions workflow running `test-smoke.js` and the `data.json` schema
validation on every push and pull request.

### - [ ] 17. Holidays

**Do not generate these from rules.** TR's Mexico company holiday list is not the
Mexican federal list — it adds two company "Mental Health Day" dates, Holy
Thursday/Friday and Bank Employee Day, and omits some federal days.

- [ ] Move holidays out of `data.json` into `holidays-2026.json`, hand-sourced
      from TR's company holidays page for Mexico. Keep the existing
      `{weekKey: [{day, name, mandateApplies?}]}` shape so nothing downstream
      changes.
- [ ] Model **two calendars, not one**. MX company holidays = the desk is
      closed. US holidays = US markets closed but the Mexico desk works — these
      carry `mandateApplies: true`, matching how Sep 7 US Labor Day is already
      encoded. Make the distinction explicit in the UI legend and in the
      Teams/Excel exports; "Holiday" currently reads as one single thing.
- [ ] Startup warning when the loaded holiday file has no entries beyond the
      current month, so the list doesn't silently run out at year end.
- [ ] Keep manual add/remove as an override on top of the file.
- [ ] Smoke test: assert the 2026 MX dates land on the weekdays they should, and
      that a `mandateApplies` holiday still counts toward the three-day office
      mandate while a plain one does not.

Remaining 2026 entries to seed. Sep 16 is already correct in `data.json`; Bank
Employee Day (Dec 12) falls on a Saturday so needs no entry.

```json
"2026-10-05": [{ "day": 4, "name": "Mental Health Day" }],
"2026-11-02": [{ "day": 0, "name": "Day of the Dead" }],
"2026-11-16": [{ "day": 0, "name": "Mexican Revolution Day" }],
"2026-11-23": [
  { "day": 3, "name": "US Thanksgiving", "mandateApplies": true },
  { "day": 4, "name": "Day After Thanksgiving (US)", "mandateApplies": true }
],
"2026-12-21": [{ "day": 4, "name": "Christmas Day" }]
```

Sources: [Company Holidays: Mexico](https://trten.sharepoint.com/sites/intr-company-holidays/SitePages/mexico.aspx)
· [2026 Company Holidays by Region](https://trten.sharepoint.com/sites/intr-cocounsel-engineering/Shared%20Documents/2026-company-holidays.pdf)
· [NYSE Holidays & Trading Hours](https://www.nyse.com/trade/hours-calendars)

NYSE also closes early at 1pm ET on Nov 27 and Dec 24 — not closures, but
relevant if staffing to market hours.

### - [ ] 18. Flag, don't fix: possible double-counted October leave

Several October vacation entries may count the Oct 9 Mental Health Day as both
leave and holiday — Carlos's entry is literally noted "Oct 9 (comp for mental
health day)" and dated Oct 9. Report what you find; leave the data alone.
