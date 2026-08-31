#!/usr/bin/env node
/*
 * Smoke test for index.html's embedded app script.
 *
 * Runs the actual script from index.html inside a minimal DOM stub (no browser,
 * no dependencies) and exercises the core logic + a static check that every
 * onclick=/onchange= handler referenced in rendered HTML has a matching function
 * definition in the file. This is the exact bug class that shipped once already
 * (addVacation/removeVacation/vacLabel referenced but not defined) — this script
 * exists to catch that automatically instead of relying on manual clicking.
 *
 * Run before every publish/push: `node test-smoke.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, 'index.html');

let failures = 0;
let passes = 0;
function check(label, cond, extra) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.log('FAIL — ' + label + (extra ? '\n       ' + extra : ''));
  }
}

// ---------------------------------------------------------------------------
// Extract the app script from index.html
// ---------------------------------------------------------------------------
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!scriptMatch) {
  console.error('Could not find the app <script> block in index.html');
  process.exit(1);
}
const rawScript = scriptMatch[1];
// Neutralize the real auto-boot call (which does a real fetch) — each test
// section drives the app manually instead.
const testableScript = rawScript.replace('bootAndRender();', '/* suppressed for test-smoke.js */');

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------
function makeStubEl() {
  const el = {
    style: {},
    value: '',
    _children: [],
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {},
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    click() {},
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = v; if (typeof v === 'string') capturedHTML.push(v); },
  });
  return el;
}

let capturedHTML = [];
const elCache = {};
function makeSandbox() {
  capturedHTML = [];
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.addEventListener = function(type, fn) { sandbox['__on_' + type] = fn; };
  sandbox.console = console;
  sandbox.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  sandbox.fetch = () => Promise.reject(new Error('network disabled in test-smoke.js'));
  sandbox.document = {
    body: makeStubEl(),
    getElementById(id) {
      if (!elCache[id]) elCache[id] = makeStubEl();
      return elCache[id];
    },
    createElement() { return makeStubEl(); },
    createRange() { return { selectNodeContents() {} }; },
  };
  sandbox.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  sandbox.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
  sandbox.Blob = function Blob() {};
  sandbox.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return 0; };
  sandbox.prompt = () => null;
  sandbox.confirm = () => true;
  sandbox.alert = () => {};
  vm.createContext(sandbox);
  vm.runInContext(testableScript, sandbox, { filename: 'index.html-script' });
  return sandbox;
}

// ===========================================================================
// 1. Pure-logic checks: isWorking, holiday 3-state cycleCell, mandate counts
// ===========================================================================
(function coreLogicChecks() {
  const g = makeSandbox();

  check("isWorking('off') is working", g.isWorking('off') === true);
  check("isWorking('wfh') is working", g.isWorking('wfh') === true);
  check("isWorking('office') is working", g.isWorking('office') === true);
  check("isWorking('vacation') is NOT working", g.isWorking('vacation') === false);
  check("isWorking('sick') is NOT working", g.isWorking('sick') === false);

  // Fresh, isolated holiday week far from any seeded data.
  const o = 8;
  const wk = g.wkKey(o);
  g.schedule[wk] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wk][m.id] = Array(5).fill('off'); });
  g.holidays[wk] = [{ day: 1, name: 'Smoke Test Holiday' }];
  g.lockedWeeks.delete(wk);
  const id = g.MEMBERS[0].id, d = 1;

  // Holiday cells cycle through the FULL status range (same as a normal day) so someone required
  // to work can be set to office/wfh, someone out that day can be marked vacation/sick directly
  // (not just via the separate vacation-log form), and someone working with another team that day
  // can be marked otherteam too.
  check('holiday cell starts at off (Holiday)', g.schedule[wk][id][d] === 'off');
  g.cycleCell(id, d, o);
  check('1st click cycles Holiday -> Office', g.schedule[wk][id][d] === 'office');
  g.cycleCell(id, d, o);
  check('2nd click cycles Office -> Home', g.schedule[wk][id][d] === 'wfh');
  g.cycleCell(id, d, o);
  check('3rd click cycles Home -> Vacation', g.schedule[wk][id][d] === 'vacation');
  g.cycleCell(id, d, o);
  check('4th click cycles Vacation -> Sick', g.schedule[wk][id][d] === 'sick');
  g.cycleCell(id, d, o);
  check('5th click cycles Sick -> Other team', g.schedule[wk][id][d] === 'otherteam');
  g.cycleCell(id, d, o);
  check('6th click cycles Other team -> back to Holiday', g.schedule[wk][id][d] === 'off');

  // officeDaysInWeek / officeDaysInMonth: office-on-holiday should count, wfh/off should not.
  g.schedule[wk][id][d] = 'off';
  const base = g.officeDaysInWeek(id, o);
  g.schedule[wk][id][d] = 'office';
  check('officeDaysInWeek credits office-on-holiday', g.officeDaysInWeek(id, o) === base + 1);
  g.schedule[wk][id][d] = 'wfh';
  check('officeDaysInWeek does not credit wfh-on-holiday', g.officeDaysInWeek(id, o) === base);

  const wkDate = g.wkDates(o)[d];
  const now = new Date();
  const mOff = (wkDate.getFullYear() - now.getFullYear()) * 12 + (wkDate.getMonth() - now.getMonth());
  g.schedule[wk][id][d] = 'off';
  const monthBase = g.officeDaysInMonth(id, mOff);
  g.schedule[wk][id][d] = 'office';
  check('officeDaysInMonth credits office-on-holiday', g.officeDaysInMonth(id, mOff) === monthBase + 1);

  g.schedule[wk][id][d] = 'off';
  const mbOff = g.monthlyBreakdown(id, mOff);
  g.schedule[wk][id][d] = 'office';
  const mbOffice = g.monthlyBreakdown(id, mOff);
  check('monthlyBreakdown moves the day from holDays to officeDays',
    mbOffice.officeDays === mbOff.officeDays + 1 && mbOffice.holDays === mbOff.holDays - 1);

  // On a GENUINE holiday, only physically working from the office restores availability — wfh
  // is still tracked informationally as a wfhDay, but (unlike office) stays counted in holDays
  // (unavailable), since working from home doesn't satisfy "come into the office" for this holiday.
  g.schedule[wk][id][d] = 'wfh';
  const mbWfh = g.monthlyBreakdown(id, mOff);
  check('monthlyBreakdown still tracks wfh-on-holiday as a wfhDay',
    mbWfh.wfhDays === mbOff.wfhDays + 1);
  check('but wfh-on-holiday (genuine holiday) stays counted in holDays, unlike office',
    mbWfh.holDays === mbOff.holDays);

  check('monthlyOfficeSoFar is callable and returns a number', typeof g.monthlyOfficeSoFar(id, mOff) === 'number');
})();

// ===========================================================================
// 1b. mandateApplies holidays: shown as Holiday to whoever is 'off', but the
//     day must still count toward the available/workable pool (no automatic
//     mandate pass) — unlike a genuine excused holiday, which excludes the day
//     entirely. This is the exact Sept-7-US-Labor-Day distinction requested.
// ===========================================================================
(function mandateAppliesHolidayChecks() {
  const g = makeSandbox();
  const id = g.MEMBERS[0].id;

  // A genuine (excused) holiday: 'off' that day should be excluded from availability.
  const oReal = 11;
  const wkReal = g.wkKey(oReal);
  g.schedule[wkReal] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wkReal][m.id] = Array(5).fill('off'); });
  g.holidays[wkReal] = [{ day: 0, name: 'Genuine Holiday' }];
  const availReal = g.availableDaysInWeek(id, oReal);
  check('genuine holiday excludes the day from availableDaysInWeek when nobody works it', availReal === 4);

  // Someone explicitly working IN THE OFFICE on a genuine holiday must not lose that day from
  // their availability — otherwise "make Mexican holidays workable for people who have to come
  // in" silently caps their effective mandate lower than it should be. Working from HOME on that
  // same holiday, though, does NOT restore availability — only physically coming in does.
  g.schedule[wkReal][id][0] = 'office';
  check('working a genuine holiday IN THE OFFICE restores the day to availableDaysInWeek', g.availableDaysInWeek(id, oReal) === 5);
  g.schedule[wkReal][id][0] = 'wfh';
  check('working a genuine holiday FROM HOME does NOT restore availableDaysInWeek', g.availableDaysInWeek(id, oReal) === 4);
  g.schedule[wkReal][id][0] = 'off';

  // A mandateApplies holiday: 'off' that day should still count as available. The other 4 days
  // are set to 'wfh' (not 'off') so they don't also register as office days and contaminate the
  // office-credit assertions below — this isolates day 0's behavior specifically. oFlag is
  // chosen far from oReal (and from any seeded holiday week) so monthlyBreakdown's whole-month
  // sum below isn't cross-contaminated by the other test's week landing in the same month.
  const oFlag = 30;
  const wkFlag = g.wkKey(oFlag);
  g.schedule[wkFlag] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wkFlag][m.id] = ['off', 'wfh', 'wfh', 'wfh', 'wfh']; });
  g.holidays[wkFlag] = [{ day: 0, name: 'US Labor Day', mandateApplies: true }];
  const availFlag = g.availableDaysInWeek(id, oFlag);
  check('mandateApplies holiday still counts the day as available (unlike a genuine holiday)', availFlag === 5);

  // Being 'off' (not working) on a mandateApplies holiday earns no office credit — same as a
  // genuine holiday — the mandate applying does NOT mean 'off' is silently treated as working.
  check('mandateApplies holiday gives no office credit for staying off', g.officeDaysInWeek(id, oFlag) === 0);
  // But actually coming in still counts, exactly like any other holiday.
  g.schedule[wkFlag][id][0] = 'office';
  check('mandateApplies holiday still credits an explicit office day', g.officeDaysInWeek(id, oFlag) === 1);

  // monthlyBreakdown: genuine holiday -> holDays (excluded); mandateApplies holiday -> neither
  // holDays nor officeDays when 'off' (available, but uncredited).
  const now = new Date();
  const wkDateReal = g.wkDates(oReal)[0];
  const mOffReal = (wkDateReal.getFullYear() - now.getFullYear()) * 12 + (wkDateReal.getMonth() - now.getMonth());
  const mbReal = g.monthlyBreakdown(id, mOffReal);
  check('monthlyBreakdown counts a genuine holiday off-day as holDays', mbReal.holDays >= 1);

  // Other weeks in the same month get lazily filled with lots of their own default 'off' days
  // (via getSched()), so monthlyBreakdown's whole-month totals aren't zero on their own — use a
  // differential comparison (wfh vs. off on day 0, everything else held constant) instead of
  // asserting an absolute count, so the check isn't sensitive to that unrelated noise.
  const wkDateFlag = g.wkDates(oFlag)[0];
  const mOffFlag = (wkDateFlag.getFullYear() - now.getFullYear()) * 12 + (wkDateFlag.getMonth() - now.getMonth());
  g.schedule[wkFlag][id][0] = 'wfh';
  const mbFlagWfh = g.monthlyBreakdown(id, mOffFlag);
  g.schedule[wkFlag][id][0] = 'off';
  const mbFlagOff = g.monthlyBreakdown(id, mOffFlag);
  check('monthlyBreakdown does NOT count a mandateApplies off-day as holDays', mbFlagOff.holDays === mbFlagWfh.holDays);
  check('monthlyBreakdown does NOT credit a mandateApplies off-day as officeDays either', mbFlagOff.officeDays === mbFlagWfh.officeDays);
  check('the mandateApplies off-day simply drops out of wfhDays too (day is available but uncredited)',
    mbFlagOff.wfhDays === mbFlagWfh.wfhDays - 1);

  // mandateApplies holidays count as available even when nobody works them (wfh included) —
  // only genuine holidays restrict the "worked it" credit to physically being in the office.
  g.schedule[wkFlag][id][0] = 'wfh';
  const mbFlagMandateWfh = g.monthlyBreakdown(id, mOffFlag);
  check('mandateApplies holiday + wfh is available and credited as wfhDays',
    mbFlagMandateWfh.wfhDays === mbFlagWfh.wfhDays && mbFlagMandateWfh.holDays === 0);

  // monthlyBreakdown: genuine holiday + wfh must land in holDays (unavailable), not wfhDays-only —
  // consistent with availableDaysInWeek's office-only rule for genuine holidays.
  g.schedule[wkReal][id][0] = 'office';
  const mbRealOffice = g.monthlyBreakdown(id, mOffReal);
  g.schedule[wkReal][id][0] = 'wfh';
  const mbRealWfh = g.monthlyBreakdown(id, mOffReal);
  check('genuine holiday + office is NOT counted in holDays (available, credited)', mbRealOffice.holDays === mbRealWfh.holDays - 1);
  check('genuine holiday + office credits officeDays', mbRealOffice.officeDays === mbRealWfh.officeDays + 1);
  g.schedule[wkReal][id][0] = 'off';
})();

// ===========================================================================
// 2. Export builders: TSV / Sheet / Teams must not throw and must surface
//    office-on-holiday workers, not just wfh-on-holiday.
// ===========================================================================
(function exportBuilderChecks() {
  const g = makeSandbox();
  const o = 9;
  const wk = g.wkKey(o);
  g.schedule[wk] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wk][m.id] = Array(5).fill('off'); });
  g.holidays[wk] = [{ day: 2, name: 'Export Test Holiday' }];
  const officeMember = g.MEMBERS[0], wfhMember = g.MEMBERS[1];
  g.schedule[wk][officeMember.id][2] = 'office';
  g.schedule[wk][wfhMember.id][2] = 'wfh';

  let tsv, sheetTsv, sheetHtml, teamsPlain;
  try { tsv = g.buildTSV(o, 'local'); } catch (e) { check('buildTSV does not throw', false, e.stack); }
  try { sheetTsv = g.buildSheetTSV(o); } catch (e) { check('buildSheetTSV does not throw', false, e.stack); }
  try { sheetHtml = g.buildSheetHTML(o); } catch (e) { check('buildSheetHTML does not throw', false, e.stack); }
  try { teamsPlain = g.buildTeamsPlain(o); } catch (e) { check('buildTeamsPlain does not throw', false, e.stack); }
  try { g.buildTeamsHTML(o); } catch (e) { check('buildTeamsHTML does not throw', false, e.stack); }

  check('buildTSV built something', typeof tsv === 'string' && tsv.length > 0);
  check('buildTSV mentions the office-on-holiday member', !!tsv && tsv.indexOf(officeMember.first) !== -1);
  check('buildTSV mentions the wfh-on-holiday member', !!tsv && tsv.indexOf(wfhMember.first) !== -1);

  check('buildSheetTSV marks the office-on-holiday member with *',
    !!sheetTsv && sheetTsv.split('\n').some((line) => line.indexOf('*' + officeMember.nick) !== -1));
  check('buildSheetTSV mentions the wfh-on-holiday member (unmarked)',
    !!sheetTsv && sheetTsv.split('\n').some((line) => line.indexOf(wfhMember.nick) !== -1));

  check('buildSheetHTML colors the office-on-holiday member green',
    !!sheetHtml && sheetHtml.indexOf('#00B050') !== -1 && sheetHtml.indexOf(officeMember.nick) !== -1);

  check('buildTeamsPlain does not throw and returns text', typeof teamsPlain === 'string' && teamsPlain.length > 0);
})();

// ===========================================================================
// 3. Static check: every onclick=/onchange= handler in rendered HTML must
//    resolve to a real function definition in the file. This is the check
//    that would have caught the addVacation/removeVacation regression.
// ===========================================================================
(function onclickHandlersExistCheck() {
  const g = makeSandbox();

  // Build a week with a holiday, a day note, and a vacation-log entry so the
  // conditional sections of the UI (holiday remove button, day-note footnote,
  // vacation log entries) actually render.
  const o = 10;
  const wk = g.wkKey(o);
  g.schedule[wk] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wk][m.id] = Array(5).fill('off'); });
  g.holidays[wk] = [{ day: 3, name: 'UI Coverage Holiday' }];
  g.notes[g.dnKey(o, g.MEMBERS[0].id, 0)] = 'coverage note';
  g.vacationLog.push({ id: g.MEMBERS[1].id, start: '2020-01-01', end: '2020-01-02', note: 'coverage vacation' });
  g.wkOffset = o;

  const renderStates = [
    () => { g.showCopy = false; g.showTeams = false; g.showExport = false; g.suggestedOffset = o; g.render(); },
    () => { g.showCopy = true; g.render(); },
    () => { g.showCopy = false; g.showTeams = true; g.render(); },
    () => { g.showTeams = false; g.showExport = true; g.render(); },
    () => { g.showExport = false; g.suggestedOffset = null; g.render(); }, // "Suggest next week" banner variant
    () => { g.setView('month'); },
  ];

  renderStates.forEach((step, i) => {
    try { step(); } catch (e) { check('render state #' + i + ' does not throw', false, e.stack); }
  });

  const combinedHtml = capturedHTML.join('\n');
  check('captured a non-trivial amount of rendered HTML to scan', combinedHtml.length > 2000);

  const attrRe = /on(?:click|change)="([^"]*)"/g;
  const callRe = /^\s*([A-Za-z_$][\w$]*)\s*\(/;
  const foundNames = new Set();
  let m;
  while ((m = attrRe.exec(combinedHtml))) {
    m[1].split(';').forEach((stmt) => {
      const cm = stmt.match(callRe);
      if (cm) foundNames.add(cm[1]);
    });
  }

  check('found a plausible number of distinct onclick/onchange handlers (>= 15)', foundNames.size >= 15,
    'found: ' + Array.from(foundNames).sort().join(', '));

  foundNames.forEach((name) => {
    const defined = new RegExp('function\\s+' + name + '\\s*\\(').test(rawScript)
      || new RegExp('(?:var|let|const)\\s+' + name + '\\s*=\\s*function').test(rawScript);
    check("onclick/onchange handler '" + name + "()' has a matching function definition", defined);
  });
})();

// ===========================================================================
// 4. Publish timestamp, changelog, and unpublished-changes detection.
//    The false-positive case here (viewing a brand-new week must NOT trip the
//    banner) is exactly what was manually re-verified in the browser; this
//    locks it in as an automated regression check.
// ===========================================================================
(function publishAndUnpublishedChangesChecks() {
  const remote = {
    schedule: {}, holidays: {},
    publishedAt: '2026-08-01T00:00:00.000Z',
    publishLog: [{ at: '2026-08-01T00:00:00.000Z', note: 'seed publish' }],
  };

  // Fresh load, no local edits: must NOT show the unpublished-changes banner.
  const g1 = makeSandbox();
  g1.applyState(remote);
  g1.UNPUBLISHED_BASELINE = g1.dataFingerprint();
  g1.loadState(); // empty localStorage in the stub -> no-op
  check('fresh load with no local edits shows no unpublished-changes banner', g1.hasUnpublishedChanges() === false);
  check('publishedAt round-trips through applyState', g1.lastPublishedAt === remote.publishedAt);
  check('publishLog round-trips through applyState', g1.publishLog.length === 1 && g1.publishLog[0].note === 'seed publish');

  // A genuine schedule edit must be detected.
  const g2 = makeSandbox();
  g2.applyState(remote);
  g2.UNPUBLISHED_BASELINE = g2.dataFingerprint();
  g2.loadState();
  const sched = g2.getSched(0);
  const mid = g2.MEMBERS[0].id;
  sched[mid][0] = sched[mid][0] === 'wfh' ? 'off' : 'wfh';
  check('a genuine schedule edit is detected as an unpublished change', g2.hasUnpublishedChanges() === true);

  // The exact false-positive risk: merely navigating to/rendering a week nobody
  // has ever touched (which lazily fills in all-default data) must not trip it.
  const g3 = makeSandbox();
  g3.applyState(remote);
  g3.UNPUBLISHED_BASELINE = g3.dataFingerprint();
  g3.loadState();
  g3.wkOffset = 20;
  try { g3.render(); } catch (e) { check('render() on an unvisited week does not throw', false, e.stack); }
  check('merely viewing a brand-new week does not falsely trigger the unpublished-changes banner',
    g3.hasUnpublishedChanges() === false);

  // publishData(): entering a note stamps publishedAt, appends to the changelog,
  // and clears the unpublished-changes flag.
  const g4 = makeSandbox();
  g4.applyState(remote);
  g4.UNPUBLISHED_BASELINE = g4.dataFingerprint();
  g4.loadState();
  const beforeCount = g4.publishLog.length;
  g4.prompt = () => 'Smoke test publish note';
  try { g4.publishData(); } catch (e) { check('publishData() does not throw', false, e.stack); }
  check('publishData() stamps a fresh lastPublishedAt', !!g4.lastPublishedAt && g4.lastPublishedAt !== remote.publishedAt);
  check('publishData() appends one changelog entry with the entered note',
    g4.publishLog.length === beforeCount + 1 && g4.publishLog[g4.publishLog.length - 1].note === 'Smoke test publish note');
  check('publishData() clears the unpublished-changes flag', g4.hasUnpublishedChanges() === false);

  // Cancelling the note prompt must abort the publish entirely.
  const g5 = makeSandbox();
  g5.applyState(remote);
  const beforeCancelCount = g5.publishLog.length, beforeCancelAt = g5.lastPublishedAt;
  g5.prompt = () => null;
  try { g5.publishData(); } catch (e) { check('publishData() cancel path does not throw', false, e.stack); }
  check('cancelling the publish note prompt aborts the publish',
    g5.publishLog.length === beforeCancelCount && g5.lastPublishedAt === beforeCancelAt);

  // Changelog stays capped at 20 entries, keeping the most recent.
  const g6 = makeSandbox();
  for (let i = 0; i < 25; i++) g6.publishLog.push({ at: new Date(2026, 0, i + 1).toISOString(), note: 'entry ' + i });
  g6.prompt = () => '';
  try { g6.publishData(); } catch (e) { check('publishData() cap check does not throw', false, e.stack); }
  check('publishLog is capped at 20 entries', g6.publishLog.length === 20);
  check('publishLog cap keeps the most recently published entry', g6.publishLog[g6.publishLog.length - 1].note === '');

  // UI: statusBannerHTML/changelogHTML must not throw and must reflect state.
  const g7 = makeSandbox();
  g7.applyState(remote);
  g7.UNPUBLISHED_BASELINE = g7.dataFingerprint();
  let bannerHtml, changelogHtml;
  try { bannerHtml = g7.statusBannerHTML(); } catch (e) { check('statusBannerHTML() does not throw', false, e.stack); }
  try { changelogHtml = g7.changelogHTML(); } catch (e) { check('changelogHTML() does not throw', false, e.stack); }
  check('statusBannerHTML() shows the formatted last-published date', !!bannerHtml && bannerHtml.indexOf('Last published') !== -1);
  check('changelogHTML() lists the seeded changelog entry', !!changelogHtml && changelogHtml.indexOf('seed publish') !== -1);
})();

// ===========================================================================
// 5. Team roster management: adding a member, soft-departing one (history
//    preserved, future weeks excluded from mandate/desk counts), the hard-
//    delete gate, and members surviving exportState()/applyState()/Publish.
// ===========================================================================
(function teamRosterManagementChecks() {
  const g = makeSandbox();

  // ---- Adding a member ----
  const beforeCount = g.MEMBERS.length;
  g.document.getElementById('mem-name').value = 'Test Person';
  g.document.getElementById('mem-display').value = '';
  g.document.getElementById('mem-initials').value = '';
  g.document.getElementById('mem-shift').value = '9';
  g.document.getElementById('mem-join').value = '';
  try { g.addMember(); } catch (e) { check('addMember() does not throw', false, e.stack); }
  check('addMember() adds exactly one member', g.MEMBERS.length === beforeCount + 1);
  const newMember = g.MEMBERS[g.MEMBERS.length - 1];
  check('new member has the entered name', !!newMember && newMember.name === 'Test Person');
  check('new member display/nick default to the first name when left blank', newMember.first === 'Test' && newMember.nick === 'Test');
  check('new member gets auto-generated initials when left blank', newMember.initials === 'TP');
  check('new member gets the selected shift', newMember.shift === '9');
  check('new member gets a slugified id', newMember.id === 'test_person');
  check("new member joinDate defaults to the current week's Monday (so it does not retroactively appear in old weeks, and avoids the weekend edge case where today's exact date could exclude them from the current week)",
    newMember.joinDate === g.wkKey(0));
  check('new member gets an avatar color from the fixed palette',
    g.AVATAR_PALETTE.some((c) => c.av === newMember.av && c.ac === newMember.ac));

  g.document.getElementById('mem-name').value = 'Test Person';
  g.addMember();
  const dupeMember = g.MEMBERS[g.MEMBERS.length - 1];
  check('adding a duplicate name gets a distinct id', dupeMember.id !== newMember.id);

  check('a brand-new member (joins today) is excluded from a week entirely before today',
    g.memberInWeek(newMember.id, -10) === false);
  check('a brand-new member IS included in the current week', g.memberInWeek(newMember.id, 0) === true);

  // ---- Removing an existing member who has real history (soft path: leaveDate = today) ----
  const id = 'karen';
  const weekBeforeLeaving = -5, weekAfterLeaving = 10;
  const wkBefore = g.wkKey(weekBeforeLeaving);
  g.schedule[wkBefore] = g.schedule[wkBefore] || {};
  g.MEMBERS.forEach((m) => { if (!g.schedule[wkBefore][m.id]) g.schedule[wkBefore][m.id] = Array(5).fill('off'); });
  g.schedule[wkBefore][id] = ['wfh', 'off', 'off', 'wfh', 'off'];
  const beforeSnapshot = g.schedule[wkBefore][id].slice();
  const officeBefore = g.officeDaysInWeek(id, weekBeforeLeaving);
  const availBefore = g.availableDaysInWeek(id, weekBeforeLeaving);
  check('karen is active in a week well before she is removed', g.memberInWeek(id, weekBeforeLeaving) === true);

  g.confirm = () => true;
  try { g.removeMember(id); } catch (e) { check('removeMember() does not throw', false, e.stack); }
  const karen = g.MEMBERS.find((m) => m.id === id);
  check('removeMember() (soft path) sets leaveDate to today, with no date prompt needed', karen.leaveDate === g.dStr(new Date()));

  // Past week must be completely untouched.
  check("the removed member's PAST week schedule is byte-for-byte unchanged",
    JSON.stringify(g.schedule[wkBefore][id]) === JSON.stringify(beforeSnapshot));
  check('officeDaysInWeek for the week before removal is unchanged', g.officeDaysInWeek(id, weekBeforeLeaving) === officeBefore);
  check('availableDaysInWeek for the week before removal is unchanged', g.availableDaysInWeek(id, weekBeforeLeaving) === availBefore);
  check('memberInWeek is still true for the week before removal', g.memberInWeek(id, weekBeforeLeaving) === true);

  // A week well after removal must exclude them from rendering AND mandate/desk math.
  check('memberInWeek is false for a week well after removal', g.memberInWeek(id, weekAfterLeaving) === false);
  check('activeMembers excludes the removed member for a week well after removal',
    g.activeMembers(weekAfterLeaving).every((m) => m.id !== id));
  check('allActiveMembers (desk counting) excludes the removed member for a week well after removal',
    g.allActiveMembers(weekAfterLeaving).every((m) => m.id !== id));
  check('officeDaysInWeek is 0 for the removed member for a week well after removal', g.officeDaysInWeek(id, weekAfterLeaving) === 0);
  check('availableDaysInWeek is 0 for the removed member for a week well after removal', g.availableDaysInWeek(id, weekAfterLeaving) === 0);

  // ---- Re-adding (e.g. returning from a secondment) ----
  try { g.reAddMember(id); } catch (e) { check('reAddMember() does not throw', false, e.stack); }
  const readded = g.MEMBERS.find((m) => m.id === id);
  check('reAddMember() clears leaveDate', !readded.leaveDate);
  check('reAddMember() sets a FRESH joinDate (today), not just clearing leaveDate', readded.joinDate === g.dStr(new Date()));
  check('after reAddMember, the member is active again in that future week', g.memberInWeek(id, weekAfterLeaving) === true);
  check('after reAddMember, the member is correctly still excluded from the well-before week (the secondment gap is preserved)',
    g.memberInWeek(id, weekBeforeLeaving) === false);

  // ---- Hard-delete gate (still reachable, now via the single removeMember() entry point) ----
  check('memberHasHistory is true for karen (real schedule entries exist)', g.memberHasHistory('karen') === true);
  check('memberHasHistory is false for the freshly-added test member', g.memberHasHistory(newMember.id) === false);

  g._alerted = false;
  g.alert = () => { g._alerted = true; };
  g.confirm = () => { g._confirmedSoft = true; return true; };
  g._confirmedSoft = false;
  g.removeMember('karen');
  check('removeMember() takes the SOFT path for a member with history (leaveDate set, not removed from MEMBERS)',
    g.MEMBERS.some((m) => m.id === 'karen') && g._confirmedSoft === true);

  // A real teammate who is already part of the PUBLISHED roster must never be hard-deletable,
  // even if they happen to have zero schedule history yet (e.g. a brand-new hire who hasn't had
  // a single WFH/vacation day recorded). Only a member added THIS session, never published, is
  // eligible. This is exactly the gap found while manually verifying against real data: Perla/the
  // intern (real, already-published members) had all-default schedules and would otherwise have
  // looked hard-deletable by a memberHasHistory()-only check.
  g.PUBLISHED_MEMBER_IDS = new Set(g.MEMBERS.map((m) => m.id)); // simulate "already published"
  check('canHardDelete is false for a published member with zero history', g.canHardDelete(newMember.id) === false);
  g._confirmedSoft = false;
  g.removeMember(newMember.id);
  check('removeMember() takes the SOFT path (not hard delete) for a published-but-historyless member',
    g.MEMBERS.some((m) => m.id === newMember.id) && g._confirmedSoft === true && g.MEMBERS.find((m) => m.id === newMember.id).leaveDate === g.dStr(new Date()));

  // Now simulate the true "just added by mistake, never published" case for a fresh member.
  g.document.getElementById('mem-name').value = 'Oops Mistake';
  g.addMember();
  const mistakeMember = g.MEMBERS[g.MEMBERS.length - 1];
  check('canHardDelete is true for a never-published member with zero history', g.canHardDelete(mistakeMember.id) === true);
  const countBeforeHardDelete = g.MEMBERS.length;
  g.removeMember(mistakeMember.id);
  check('removeMember() takes the HARD path for a never-published member with zero history',
    g.MEMBERS.length === countBeforeHardDelete - 1 && !g.MEMBERS.some((m) => m.id === mistakeMember.id));

  // ---- exportState()/applyState() round-trip, including a departed member ----
  const g2 = makeSandbox();
  g2.MEMBERS.find((m) => m.id === 'mafe').leaveDate = '2026-12-01';
  const exported = JSON.parse(JSON.stringify(g2.exportState()));
  const g3 = makeSandbox();
  try { g3.applyState(exported); } catch (e) { check('applyState() round-trips members without throwing', false, e.stack); }
  check('members (including leaveDate) round-trip through exportState/applyState',
    g3.MEMBERS.some((m) => m.id === 'mafe' && m.leaveDate === '2026-12-01'));

  // ---- dataFingerprint reacts to roster changes (so Publish/unpublished-changes notices it) ----
  const g4 = makeSandbox();
  const fp1 = g4.dataFingerprint();
  g4.document.getElementById('mem-name').value = 'Fingerprint Test';
  g4.addMember();
  const fp2 = g4.dataFingerprint();
  check('adding a member changes the data fingerprint (registers as an unpublished change)', fp1 !== fp2);
})();

// ===========================================================================
// 6. Holiday cells must reach the FULL status range via direct click (not just
//    office/wfh via the 3-state cycle, and not just vacation via the separate
//    vacation-log form) — someone required to work should be settable to
//    office/wfh, and someone out that day should be directly settable to
//    vacation/sick too, with mandate math and exports handling it correctly
//    either way it was set.
// ===========================================================================
(function holidayFullCycleChecks() {
  const g = makeSandbox();
  const id = g.MEMBERS[0].id;

  // Genuine holiday: reaching 'vacation'/'sick' via cycleCell (not the vacation-log form). Days
  // 1-4 are 'wfh' (not 'off') so they don't also register as office days and contaminate the
  // office-credit assertions below — isolates day 0's behavior specifically.
  const oReal = 13;
  const wkReal = g.wkKey(oReal);
  g.schedule[wkReal] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wkReal][m.id] = ['off', 'wfh', 'wfh', 'wfh', 'wfh']; });
  g.holidays[wkReal] = [{ day: 0, name: 'Full-Cycle Holiday' }];

  g.schedule[wkReal][id][0] = 'vacation'; // simulate having clicked through to it
  check('availableDaysInWeek excludes a holiday day the click-cycle set to vacation', g.availableDaysInWeek(id, oReal) === 4);
  check('officeDaysInWeek gives no credit for a holiday day set to vacation', g.officeDaysInWeek(id, oReal) === 0);

  g.schedule[wkReal][id][0] = 'sick';
  check('availableDaysInWeek excludes a holiday day the click-cycle set to sick', g.availableDaysInWeek(id, oReal) === 4);
  check('officeDaysInWeek gives no credit for a holiday day set to sick', g.officeDaysInWeek(id, oReal) === 0);

  const now = new Date();
  const wkDateReal = g.wkDates(oReal)[0];
  const mOffReal = (wkDateReal.getFullYear() - now.getFullYear()) * 12 + (wkDateReal.getMonth() - now.getMonth());
  const mbSick = g.monthlyBreakdown(id, mOffReal);
  g.schedule[wkReal][id][0] = 'vacation';
  const mbVacation = g.monthlyBreakdown(id, mOffReal);
  check('monthlyBreakdown buckets a holiday-day sick entry into sickDays', mbSick.sickDays === mbVacation.sickDays + 1);
  check('monthlyBreakdown buckets a holiday-day vacation entry into vacDays', mbVacation.vacDays === mbSick.vacDays + 1);

  // mandateApplies holiday: same vacation/sick handling must hold.
  const oFlag = 31;
  const wkFlag = g.wkKey(oFlag);
  g.schedule[wkFlag] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wkFlag][m.id] = Array(5).fill('off'); });
  g.holidays[wkFlag] = [{ day: 0, name: 'Full-Cycle US Holiday', mandateApplies: true }];
  g.schedule[wkFlag][id][0] = 'sick';
  check('mandateApplies holiday day set to sick is excluded from availableDaysInWeek', g.availableDaysInWeek(id, oFlag) === 4);

  // Export builders must surface a holiday-day vacation/sick entry in the Leaves row, exactly
  // like they already do for a vacation-log entry.
  g.schedule[wkReal][id][0] = 'sick';
  const memberFirst = g.MEMBERS.find((m) => m.id === id).first;
  let sheetTsv, tsv;
  try { sheetTsv = g.buildSheetTSV(oReal); } catch (e) { check('buildSheetTSV does not throw with a holiday-day sick entry', false, e.stack); }
  try { tsv = g.buildTSV(oReal, 'local'); } catch (e) { check('buildTSV does not throw with a holiday-day sick entry', false, e.stack); }
  check('buildSheetTSV Leaves row mentions the holiday-day sick member',
    !!sheetTsv && sheetTsv.split('\n').some((line) => line.startsWith('Leaves') && line.indexOf(g.MEMBERS.find((m) => m.id === id).nick) !== -1));
  check('buildTSV Leaves row mentions the holiday-day sick member',
    !!tsv && tsv.split('\n').some((line) => line.startsWith('Leaves') && line.indexOf(memberFirst) !== -1));
})();

// ===========================================================================
// 7. 'otherteam' status: working, but with a different team that day — must
//    count toward the person's own office-day mandate, but must NEVER count
//    toward this team's desk limit, and must render/export distinctly from
//    both 'office' and 'wfh'.
// ===========================================================================
(function otherTeamStatusChecks() {
  const g = makeSandbox();
  const id = g.MEMBERS[0].id;

  check("isWorking('otherteam') is working", g.isWorking('otherteam') === true);

  // Isolate day 0 the same way earlier sections do — other days set to 'wfh' so they don't
  // contaminate the office-credit assertions.
  const o = 40;
  const wk = g.wkKey(o);
  g.schedule[wk] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wk][m.id] = ['otherteam', 'wfh', 'wfh', 'wfh', 'wfh']; });

  check('otherteam credits officeDaysInWeek (counts toward the personal mandate)', g.officeDaysInWeek(id, o) === 1);
  check('otherteam counts as available', g.availableDaysInWeek(id, o) === 5);

  // The desk-limit check (mirrored from render()'s inline logic) must NOT count otherteam as
  // occupying one of this team's seats, even though the day isn't a holiday.
  const officeVal = 'off'; // non-holiday day -> desk occupancy is judged by literal 'off'
  const occupiesDesk = g.schedule[wk][id][0] === officeVal;
  check('otherteam does NOT match the desk-occupancy value (excluded from the 6-seat count)', occupiesDesk === false);

  // Same on a holiday day: otherteam should credit office (like 'office' does) and still be
  // excluded from desk occupancy (judged by literal 'office' on a holiday day).
  const oHol = 41;
  const wkHol = g.wkKey(oHol);
  g.schedule[wkHol] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wkHol][m.id] = ['otherteam', 'wfh', 'wfh', 'wfh', 'wfh']; });
  g.holidays[wkHol] = [{ day: 0, name: 'Otherteam Holiday Test' }];
  check('otherteam on a holiday still credits officeDaysInWeek', g.officeDaysInWeek(id, oHol) === 1);
  check('otherteam restores availability on a genuine holiday (like office does)', g.availableDaysInWeek(id, oHol) === 5);
  check('otherteam on a holiday does not match the holiday desk-occupancy value (office)',
    g.schedule[wkHol][id][0] !== 'office');

  // monthlyBreakdown must credit otherteam the same way as office.
  const now = new Date();
  const wkDate = g.wkDates(o)[0];
  const mOff = (wkDate.getFullYear() - now.getFullYear()) * 12 + (wkDate.getMonth() - now.getMonth());
  g.schedule[wk][id][0] = 'off';
  const mbOff = g.monthlyBreakdown(id, mOff);
  g.schedule[wk][id][0] = 'otherteam';
  const mbOtherTeam = g.monthlyBreakdown(id, mOff);
  check('monthlyBreakdown credits an otherteam day the same as an office day',
    mbOtherTeam.officeDays === mbOff.officeDays);

  // Export builders must tag/color otherteam distinctly from office (O) and wfh (H).
  check("attendanceTag('otherteam') is 'T' (distinct from office/wfh)", g.attendanceTag('otherteam') === 'T');
  check("sheetPrefix('otherteam') is distinct from office's '*' and wfh's ''",
    g.sheetPrefix('otherteam') === '^' && g.sheetPrefix('otherteam') !== g.sheetPrefix('office') && g.sheetPrefix('otherteam') !== g.sheetPrefix('wfh'));

  let tsv, sheetTsv, sheetHtml;
  try { tsv = g.buildTSV(o, 'local'); } catch (e) { check('buildTSV does not throw with an otherteam entry', false, e.stack); }
  try { sheetTsv = g.buildSheetTSV(o); } catch (e) { check('buildSheetTSV does not throw with an otherteam entry', false, e.stack); }
  try { sheetHtml = g.buildSheetHTML(o); } catch (e) { check('buildSheetHTML does not throw with an otherteam entry', false, e.stack); }
  const memberFirst2 = g.MEMBERS.find((m) => m.id === id).first;
  const memberNick2 = g.MEMBERS.find((m) => m.id === id).nick;
  check('buildTSV tags the otherteam member with (T)', !!tsv && tsv.indexOf(memberFirst2 + ' (T)') !== -1);
  check('buildSheetTSV marks the otherteam member with ^', !!sheetTsv && sheetTsv.split('\n').some((line) => line.indexOf('^' + memberNick2) !== -1));
  check('buildSheetHTML colors the otherteam member with the distinct blue, not WFO green',
    !!sheetHtml && sheetHtml.indexOf('#2E75B6') !== -1);

  // Cell classes/labels must be distinct.
  check("stLabel('otherteam') is 'Other team'", g.stLabel('otherteam') === 'Other team');
})();

// ===========================================================================
// 8. Editable display names: renaming a member's display name must update
//    first/nick for rendering/exports, but the id (the key all historical
//    schedule/vacation/note data is keyed on) must never change.
// ===========================================================================
(function editMemberNameChecks() {
  const g = makeSandbox();
  const id = 'karen';
  const wk = g.wkKey(0);
  g.schedule[wk] = g.schedule[wk] || {};
  g.MEMBERS.forEach((m) => { if (!g.schedule[wk][m.id]) g.schedule[wk][m.id] = Array(5).fill('off'); });
  g.schedule[wk][id][0] = 'wfh'; // some real history tied to this id

  g.prompt = () => 'Karencita';
  try { g.editMemberName(id); } catch (e) { check('editMemberName() does not throw', false, e.stack); }
  const renamed = g.MEMBERS.find((m) => m.id === id);
  check('editMemberName() updates first', renamed.first === 'Karencita');
  check('editMemberName() updates nick', renamed.nick === 'Karencita');
  check('editMemberName() does NOT change the id', renamed.id === 'karen');
  check("historical schedule data keyed by id is untouched by the rename", g.schedule[wk]['karen'][0] === 'wfh');

  // Cancelling the prompt must leave the name untouched.
  const beforeCancel = g.MEMBERS.find((m) => m.id === id).first;
  g.prompt = () => null;
  g.editMemberName(id);
  check('cancelling editMemberName() leaves the display name unchanged', g.MEMBERS.find((m) => m.id === id).first === beforeCancel);

  // An empty name must be rejected.
  g._alerted = false;
  g.alert = () => { g._alerted = true; };
  g.prompt = () => '   ';
  g.editMemberName(id);
  check('editMemberName() rejects a blank display name (alerted, unchanged)',
    g.MEMBERS.find((m) => m.id === id).first === beforeCancel && g._alerted === true);
})();

// ===========================================================================
// 9. Hiding a teammate is a per-week view/declutter choice — it must NOT
//    carry over to other weeks, and must never affect desk-limit counting
//    (which intentionally still counts hidden members).
// ===========================================================================
(function perWeekHideChecks() {
  const g = makeSandbox();
  const id = 'ricardo';
  const weekA = 8, weekB = 9;

  check('not hidden anywhere by default', g.isHiddenInWeek(id, weekA) === false && g.isHiddenInWeek(id, weekB) === false);

  g.toggleHidden(id, weekA);
  check('toggleHidden hides the member in the targeted week', g.isHiddenInWeek(id, weekA) === true);
  check('toggleHidden does NOT hide the member in a different week', g.isHiddenInWeek(id, weekB) === false);
  check('activeMembers excludes the hidden member in that week',
    g.activeMembers(weekA).every((m) => m.id !== id));
  check('activeMembers still includes the same member in a different week',
    g.activeMembers(weekB).some((m) => m.id === id));
  check('allActiveMembers (desk counting) still includes the hidden member — hiding must not affect desk math',
    g.allActiveMembers(weekA).some((m) => m.id === id));

  g.toggleHidden(id, weekA);
  check('toggling again un-hides them in that same week', g.isHiddenInWeek(id, weekA) === false);

  // Legacy data: an old-format publish with a flat hiddenMembers array (global, pre-this-feature)
  // must migrate to hiding those members in the CURRENT week only, not silently discarding the
  // preference and not applying it globally either.
  const g2 = makeSandbox();
  const curWk = g2.wkKey(0);
  g2.applyState({ hiddenMembers: ['perla', 'ricardo_int'] });
  check('legacy hiddenMembers migrates into hiddenByWeek for the current week',
    g2.isHiddenInWeek('perla', 0) === true && g2.isHiddenInWeek('ricardo_int', 0) === true);
  check('legacy hiddenMembers migration does NOT apply to other weeks',
    g2.isHiddenInWeek('perla', 5) === false);

  // exportState()/applyState() round-trip.
  const g3 = makeSandbox();
  g3.toggleHidden('alan', 3);
  const exported = JSON.parse(JSON.stringify(g3.exportState()));
  check('exportState uses the new hiddenByWeek field, not the old flat hiddenMembers', !exported.hiddenMembers && !!exported.hiddenByWeek);
  const g4 = makeSandbox();
  g4.applyState(exported);
  check('hiddenByWeek round-trips through exportState/applyState', g4.isHiddenInWeek('alan', 3) === true && g4.isHiddenInWeek('alan', 4) === false);

  // dataFingerprint must not flap from hide/un-hide leaving an empty array behind.
  const g5 = makeSandbox();
  const fpBefore = g5.dataFingerprint();
  g5.toggleHidden('mafe', 12);
  g5.toggleHidden('mafe', 12); // un-hide again, leaves hiddenByWeek[wk] = [] behind
  const fpAfter = g5.dataFingerprint();
  check('hiding then un-hiding (leaving an empty array) does not change the data fingerprint', fpBefore === fpAfter);
})();

// ===========================================================================
// 10. Alert noise reduction: the WFH-rebalance alert must only fire on a
//     genuine majority (not any 3+), and the late-shift alert must only fire
//     when someone is actually assigned to that shift band this week at all.
// ===========================================================================
(function alertThresholdChecks() {
  // ---- WFH majority threshold ----
  const g = makeSandbox();
  const o = 15;
  const wk = g.wkKey(o);
  g.schedule[wk] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wk][m.id] = Array(5).fill('off'); });
  // Default active team from DEFAULT_MEMBERS is 8 people; put exactly 3 on wfh Monday (not a
  // holiday week) — this must NOT trigger the alert per the explicit "3 doesn't need rebalancing" feedback.
  const activeIds = g.activeMembers(o).map((m) => m.id);
  check('sanity: default active team has more than 6 people for this threshold test', activeIds.length > 6);
  for (let i = 0; i < 3; i++) g.schedule[wk][activeIds[i]][0] = 'wfh';
  g.wkOffset = o;
  g.holidays[wk] = [];
  try { g.render(); } catch (e) { check('render() with 3 WFH does not throw', false, e.stack); }
  let combined = capturedHTML.join('\n');
  check('3 people WFH does NOT trigger the "consider rebalancing" alert', combined.indexOf('consider rebalancing') === -1);

  // Now push it to a genuine majority.
  const g2 = makeSandbox();
  const o2 = 16;
  const wk2 = g2.wkKey(o2);
  g2.schedule[wk2] = {};
  g2.MEMBERS.forEach((m) => { g2.schedule[wk2][m.id] = Array(5).fill('off'); });
  const activeIds2 = g2.activeMembers(o2).map((m) => m.id);
  const majority = Math.floor(activeIds2.length / 2) + 1;
  for (let i = 0; i < majority; i++) g2.schedule[wk2][activeIds2[i]][0] = 'wfh';
  g2.wkOffset = o2;
  try { g2.render(); } catch (e) { check('render() with a WFH majority does not throw', false, e.stack); }
  combined = capturedHTML.join('\n');
  check('a genuine majority WFH DOES trigger the "consider rebalancing" alert', combined.indexOf('consider rebalancing') !== -1);

  // ---- Late-shift alert only when someone is actually on that shift this week ----
  const g3 = makeSandbox();
  const o3 = 17;
  const wk3 = g3.wkKey(o3);
  g3.schedule[wk3] = {};
  g3.MEMBERS.forEach((m) => { g3.schedule[wk3][m.id] = Array(5).fill('off'); }); // everyone in office
  g3.weekShift[wk3] = {};
  g3.MEMBERS.forEach((m) => { g3.weekShift[wk3][m.id] = '10'; }); // nobody on the 11-7 late band
  g3.shiftOv[wk3] = {};
  g3.MEMBERS.forEach((m) => { g3.shiftOv[wk3][m.id] = [null, null, null, null, null]; });
  g3.wkOffset = o3;
  try { g3.render(); } catch (e) { check('render() with nobody on late shift does not throw', false, e.stack); }
  combined = capturedHTML.join('\n');
  check('no late-shift alert when literally nobody is assigned the 11-7 band this week',
    combined.indexOf('no one on late shift') === -1);

  // Sanity: if at least one person IS on the late band but not in office, the alert should still work.
  const g4 = makeSandbox();
  const o4 = 18;
  const wk4 = g4.wkKey(o4);
  g4.schedule[wk4] = {};
  g4.MEMBERS.forEach((m) => { g4.schedule[wk4][m.id] = Array(5).fill('off'); });
  g4.weekShift[wk4] = {};
  g4.MEMBERS.forEach((m) => { g4.weekShift[wk4][m.id] = '10'; });
  const lateId = g4.MEMBERS[0].id;
  g4.weekShift[wk4][lateId] = '11';
  g4.schedule[wk4][lateId][0] = 'wfh'; // the only late-shift person is WFH, not in office, on Monday
  g4.wkOffset = o4;
  try { g4.render(); } catch (e) { check('render() with an absent late-shift person does not throw', false, e.stack); }
  combined = capturedHTML.join('\n');
  check('late-shift alert still fires when someone IS assigned that band but is not in office that day',
    combined.indexOf('no one on late shift') !== -1);
})();

// ===========================================================================
// 11. Vacation/other-team log bulk assignment: adding an 'otherteam' entry
//     must stamp every weekday in the range, not just one day at a time.
// ===========================================================================
(function otherTeamLogChecks() {
  const g = makeSandbox();
  const id = 'ricardo';
  g.document.getElementById('vac-member').value = id;
  g.document.getElementById('vac-start').value = '2026-09-07';
  g.document.getElementById('vac-end').value = '2026-09-11';
  g.document.getElementById('vac-note').value = 'with platform team';
  g.setVacType('otherteam');
  try { g.addVacation(); } catch (e) { check('addVacation() with type=otherteam does not throw', false, e.stack); }
  const entry = g.vacationLog[g.vacationLog.length - 1];
  check("addVacation() records the entry with type 'otherteam'", !!entry && entry.type === 'otherteam');
  const wk = '2026-09-07';
  check('the whole week (Mon-Fri) got stamped otherteam in one shot, not just one day',
    g.schedule[wk][id].every((v) => v === 'otherteam'));

  // Removing it must revert every day back to office.
  const idx = g.vacationLog.indexOf(entry);
  g.confirm = () => true;
  try { g.removeVacation(idx); } catch (e) { check('removeVacation() on an otherteam entry does not throw', false, e.stack); }
  check('removing the otherteam log entry reverts the whole week to off', g.schedule[wk][id].every((v) => v === 'off'));

  // A plain vacation entry must still default to type 'vacation' when the selector is left as-is.
  const g2 = makeSandbox();
  g2.document.getElementById('vac-member').value = 'karen';
  g2.document.getElementById('vac-start').value = '2026-10-05';
  g2.document.getElementById('vac-end').value = '2026-10-05';
  g2.setVacType('vacation');
  g2.addVacation();
  const vacEntry = g2.vacationLog[g2.vacationLog.length - 1];
  check("a normal vacation entry keeps type 'vacation'", vacEntry.type === 'vacation');
  check('vacation entries still stamp the vacation status, not otherteam', g2.schedule['2026-10-05'].karen[0] === 'vacation');
})();

// ===========================================================================
// 12. Editing a vacation/other-team log entry in place (extend, shrink, or
//     change member) instead of deleting and re-creating it.
// ===========================================================================
(function editVacationEntryChecks() {
  const g = makeSandbox();
  const id = 'ricardo';
  g.document.getElementById('vac-member').value = id;
  g.document.getElementById('vac-start').value = '2026-09-07';
  g.document.getElementById('vac-end').value = '2026-09-11';
  g.setVacType('otherteam');
  g.addVacation();
  const idx = g.vacationLog.length - 1;

  check('startEditVacation sets editingVacationIdx', (g.startEditVacation(idx), g.editingVacationIdx === idx));

  // ---- Extend the range by a week (add days) ----
  g.document.getElementById('vac-member').value = id;
  g.document.getElementById('vac-start').value = '2026-09-07';
  g.document.getElementById('vac-end').value = '2026-09-18'; // now two full weeks
  g.setVacType('otherteam');
  try { g.saveVacationEdit(); } catch (e) { check('saveVacationEdit() does not throw (extend)', false, e.stack); }
  check('saveVacationEdit() extends the range — original week still otherteam',
    g.schedule['2026-09-07'][id].every((v) => v === 'otherteam'));
  // 2026-09-14 is seeded with a genuine Mexico Independence Day holiday on Wednesday (index 2) —
  // that day must stay 'off' (Holiday), not become otherteam; the other 4 days of the new week do.
  check('saveVacationEdit() extends the range — the new week is otherteam EXCEPT the genuine holiday day',
    g.schedule['2026-09-14'][id][0] === 'otherteam' && g.schedule['2026-09-14'][id][1] === 'otherteam' &&
    g.schedule['2026-09-14'][id][2] === 'off' && g.schedule['2026-09-14'][id][3] === 'otherteam' &&
    g.schedule['2026-09-14'][id][4] === 'otherteam');
  check('editingVacationIdx is cleared after saving', g.editingVacationIdx === null);
  check('editing did not create a second log entry — the original entry was updated in place',
    g.vacationLog.length === 1 && g.vacationLog[0].end === '2026-09-18');

  // ---- Shrink the range (remove the second week again) ----
  g.startEditVacation(idx);
  g.document.getElementById('vac-member').value = id;
  g.document.getElementById('vac-start').value = '2026-09-07';
  g.document.getElementById('vac-end').value = '2026-09-11';
  g.setVacType('otherteam');
  g.saveVacationEdit();
  check('shrinking the range reverts the dropped week to off',
    g.schedule['2026-09-14'][id].every((v) => v === 'off'));
  check('shrinking the range keeps the remaining week intact',
    g.schedule['2026-09-07'][id].every((v) => v === 'otherteam'));

  // ---- Changing the member mid-edit reverts the OLD member's days and stamps the new one ----
  g.startEditVacation(idx);
  g.document.getElementById('vac-member').value = 'karen';
  g.document.getElementById('vac-start').value = '2026-09-07';
  g.document.getElementById('vac-end').value = '2026-09-11';
  g.setVacType('otherteam');
  g.saveVacationEdit();
  check("changing the member during edit reverts the OLD member's days", g.schedule['2026-09-07'][id].every((v) => v === 'off'));
  check('changing the member during edit stamps the NEW member', g.schedule['2026-09-07'].karen.every((v) => v === 'otherteam'));

  // ---- Cancel must leave everything untouched ----
  g.startEditVacation(0);
  check('cancelEditVacation clears editingVacationIdx', (g.cancelEditVacation(), g.editingVacationIdx === null));
  check('cancel does not modify the entry', g.vacationLog[0].id === 'karen');

  // ---- Removing an entry that is mid-edit clears the editing index ----
  g.startEditVacation(0);
  g.confirm = () => true;
  g.removeVacation(0);
  check('removing the entry being edited clears editingVacationIdx', g.editingVacationIdx === null);

  // ---- Removing an earlier entry decrements a later editingVacationIdx instead of going stale ----
  const g2 = makeSandbox();
  g2.document.getElementById('vac-member').value = 'karen';
  g2.document.getElementById('vac-start').value = '2026-09-07';
  g2.addVacation();
  g2.document.getElementById('vac-member').value = 'mafe';
  g2.document.getElementById('vac-start').value = '2026-09-08';
  g2.addVacation();
  g2.startEditVacation(1); // editing mafe's entry
  g2.confirm = () => true;
  g2.removeVacation(0); // remove karen's entry (index 0), shifting mafe's entry to index 0
  check('editingVacationIdx shifts down when an earlier entry is removed', g2.editingVacationIdx === 0);
  check('the entry still being edited is still mafe\'s', g2.vacationLog[g2.editingVacationIdx].id === 'mafe');
})();

// ===========================================================================
// 12b. The vacation/other-team type is a visible toggle, not a silently-
//      defaulted <select> — this is the exact bug that shipped once already
//      (an entry meant as "other team" got logged as a vacation because the
//      dropdown defaulted to Vacation and nothing made that obvious).
// ===========================================================================
(function vacTypeToggleChecks() {
  const g = makeSandbox();
  check("vacTypeSelection defaults to 'vacation'", g.vacTypeSelection === 'vacation');

  g.wkOffset = 0;
  g.render();
  let panel = g.document.getElementById('vacation-section').innerHTML;
  check('the type toggle renders two distinct buttons, not a hidden/silent default',
    panel.indexOf("setVacType('vacation')") !== -1 && panel.indexOf("setVacType('otherteam')") !== -1);

  // The actual regression: setVacType() must NEVER trigger a full render(), because render()
  // rebuilds this whole section via innerHTML, which (in a real browser) destroys and recreates
  // the member/date/note inputs — silently snapping the member <select> back to its first option
  // (Karen) and blanking any dates/notes already typed. This harness's DOM stub doesn't model
  // that destructive innerHTML behavior, so the only reliable way to catch it is to confirm
  // render() is never called at all, and that the toggle instead updates itself directly.
  let renderCalls = 0;
  const origRender = g.render;
  g.render = function () { renderCalls++; return origRender.apply(this, arguments); };
  g.setVacType('otherteam');
  check('setVacType updates the selection', g.vacTypeSelection === 'otherteam');
  check('setVacType does NOT call render() (would wipe the in-progress member/date/note fields)', renderCalls === 0);
  g.render = origRender;

  check("setVacType updates the 'otherteam' button's own style directly (active)",
    g.document.getElementById('vac-type-btn-otherteam').style.cssText.indexOf('font-weight:600') !== -1);
  check("setVacType updates the 'vacation' button's own style directly (inactive)",
    g.document.getElementById('vac-type-btn-vacation').style.cssText.indexOf('font-weight:600') === -1);

  // Adding an entry without touching the toggle must still default to vacation (intentional,
  // documented default) — but selecting otherteam first must actually produce an otherteam entry.
  g.document.getElementById('vac-member').value = 'karen';
  g.document.getElementById('vac-start').value = '2026-11-02';
  g.addVacation();
  check('selecting Other team before Add produces an otherteam entry', g.vacationLog[g.vacationLog.length - 1].type === 'otherteam');
  check('the toggle resets to vacation after a successful add (ready for the next entry)', g.vacTypeSelection === 'vacation');

  // Editing an entry must load the toggle to match that entry's actual type.
  const idx = g.vacationLog.length - 1;
  g.startEditVacation(idx);
  check('editing an otherteam entry sets the toggle to otherteam', g.vacTypeSelection === 'otherteam');
  g.cancelEditVacation();
  check('cancelling resets the toggle back to vacation', g.vacTypeSelection === 'vacation');
})();

// ===========================================================================
// 12c. A genuine (excused) holiday is never bulk-overwritten by the vacation/
//      other-team log, for ANY entry type — it's a company-wide day off, not
//      something a personal vacation or other-team assignment should relabel.
//      An 'otherteam' assignment additionally must never override — or, on
//      removal, clobber — an existing vacation/sick day. This is exactly the
//      bug that shipped: a wide otherteam range silently erased a narrower
//      pre-existing vacation entry and a Mexican public holiday underneath it.
// ===========================================================================
(function otherTeamPriorityChecks() {
  const g = makeSandbox();
  const id = 'ricardo';
  const o = 60;
  const wk = g.wkKey(o);
  // Day 0 (Mon): pre-existing vacation. Day 1 (Tue): pre-existing sick. Day 2 (Wed): plain, no
  // conflict. Day 3 (Thu): genuine (excused) holiday. Day 4 (Fri): mandateApplies (US) holiday.
  g.schedule[wk] = {};
  g.MEMBERS.forEach((m) => { g.schedule[wk][m.id] = Array(5).fill('off'); });
  g.schedule[wk][id] = ['vacation', 'sick', 'off', 'off', 'off'];
  g.holidays[wk] = [{ day: 3, name: 'Genuine Holiday' }, { day: 4, name: 'US Holiday', mandateApplies: true }];

  const entry = { id: id, start: g.wkKey(o), end: g.dStr(g.wkDates(o)[4]), type: 'otherteam' };
  g.stampVacation(entry, 'otherteam');
  check('otherteam does not override an existing vacation day', g.schedule[wk][id][0] === 'vacation');
  check('otherteam does not override an existing sick day', g.schedule[wk][id][1] === 'sick');
  check('otherteam applies normally to a plain day with no conflicting status', g.schedule[wk][id][2] === 'otherteam');
  check('otherteam does not override a genuine holiday day (stays off/Holiday)', g.schedule[wk][id][3] === 'off');
  check('otherteam DOES apply on a mandateApplies (US) holiday day', g.schedule[wk][id][4] === 'otherteam');

  // Removing/reverting must not clobber the days that were correctly left untouched.
  g.stampVacation(entry, 'off');
  check('reverting otherteam leaves the vacation day untouched', g.schedule[wk][id][0] === 'vacation');
  check('reverting otherteam leaves the sick day untouched', g.schedule[wk][id][1] === 'sick');
  check('reverting otherteam correctly clears the plain day it DID apply to', g.schedule[wk][id][2] === 'off');
  check('reverting otherteam leaves the genuine holiday day untouched (still off)', g.schedule[wk][id][3] === 'off');
  check('reverting otherteam correctly clears the mandateApplies-holiday day it DID apply to', g.schedule[wk][id][4] === 'off');

  // A plain 'vacation'-type entry still overwrites an existing vacation/sick day (unchanged
  // behavior — a re-log for the same person is expected to win), but it must NOT overwrite a
  // genuine holiday day: that's the reported bug (Sept 16 showing as Vacation instead of Holiday
  // because it fell inside a wider vacation date range). A mandateApplies holiday, not being
  // excused for anyone, is still fair game for a vacation entry same as before.
  const g2 = makeSandbox();
  const o2 = 61;
  const wk2 = g2.wkKey(o2);
  g2.schedule[wk2] = {};
  g2.MEMBERS.forEach((m) => { g2.schedule[wk2][m.id] = Array(5).fill('off'); });
  g2.schedule[wk2][id] = ['sick', 'off', 'off', 'off', 'off'];
  g2.holidays[wk2] = [{ day: 1, name: 'Genuine Holiday' }, { day: 2, name: 'US Holiday', mandateApplies: true }];
  const vacEntry = { id: id, start: g2.wkKey(o2), end: g2.dStr(g2.wkDates(o2)[4]), type: 'vacation' };
  g2.stampVacation(vacEntry, 'vacation');
  check('a plain vacation entry still overwrites an existing sick day (unchanged behavior)', g2.schedule[wk2][id][0] === 'vacation');
  check('a plain vacation entry does NOT override a genuine holiday day (stays off/Holiday)', g2.schedule[wk2][id][1] === 'off');
  check('a plain vacation entry DOES apply on a mandateApplies (US) holiday day', g2.schedule[wk2][id][2] === 'vacation');
})();

// ===========================================================================
// 13. Direct-to-file publish (File System Access API) with graceful fallback.
//     Runs async (real awaits), so the Summary print/exit is chained after it
//     resolves rather than running as plain top-level code.
// ===========================================================================
function makeFakeHandle(mode) {
  // mode: 'granted' | 'prompt-then-granted' | 'denied'
  const writes = [];
  return {
    _writes: writes,
    async queryPermission() { return mode === 'granted' ? 'granted' : 'prompt'; },
    async requestPermission() { return mode === 'prompt-then-granted' ? 'granted' : 'denied'; },
    async createWritable() {
      return { async write(data) { writes.push(data); }, async close() {} };
    },
  };
}

(async function directFilePublishChecks() {
  // ---- verifyHandlePermission ----
  const g0 = makeSandbox();
  check('verifyHandlePermission is true when already granted', await g0.verifyHandlePermission(makeFakeHandle('granted')) === true);
  check('verifyHandlePermission is true when prompt then granted', await g0.verifyHandlePermission(makeFakeHandle('prompt-then-granted')) === true);
  check('verifyHandlePermission is false when denied', await g0.verifyHandlePermission(makeFakeHandle('denied')) === false);

  // ---- Direct write succeeds: no download, stamps committed, handle cached for next time ----
  const g1 = makeSandbox();
  let pickerCalls = 0;
  const handle1 = makeFakeHandle('granted');
  g1.window.showSaveFilePicker = async () => { pickerCalls++; return handle1; };
  g1.prompt = () => 'direct write test';
  const beforeLog1 = g1.publishLog.length;
  try { await g1.publishData(); } catch (e) { check('publishData() (direct write) does not throw', false, e.stack); }
  check('direct write: file picker was called exactly once (first publish)', pickerCalls === 1);
  check('direct write: the exported JSON was actually written to the handle', handle1._writes.length === 1 && JSON.parse(handle1._writes[0]).publishedAt === g1.lastPublishedAt);
  check('direct write: publishLog was committed', g1.publishLog.length === beforeLog1 + 1);
  check('direct write: unpublished-changes baseline updated (banner clears)', g1.hasUnpublishedChanges() === false);

  // Publishing again must reuse the cached handle, NOT re-prompt the picker.
  g1.prompt = () => 'second publish';
  await g1.publishData();
  check('direct write: second publish reuses the cached handle (picker not called again)', pickerCalls === 1);
  check('direct write: second publish wrote again', handle1._writes.length === 2);

  // ---- Cancelling the file picker (AbortError) aborts the publish entirely ----
  const g2 = makeSandbox();
  const abortErr = new Error('cancelled'); abortErr.name = 'AbortError';
  g2.window.showSaveFilePicker = async () => { throw abortErr; };
  g2.prompt = () => 'should not be published';
  const beforeAt2 = g2.lastPublishedAt, beforeLog2 = g2.publishLog.length;
  try { await g2.publishData(); } catch (e) { check('publishData() cancel path does not throw', false, e.stack); }
  check('cancelling the file picker leaves lastPublishedAt untouched', g2.lastPublishedAt === beforeAt2);
  check('cancelling the file picker does not add a changelog entry', g2.publishLog.length === beforeLog2);

  // ---- A non-cancel write failure falls back to download AND still commits the publish ----
  const g3 = makeSandbox();
  g3.window.showSaveFilePicker = async () => ({
    async queryPermission() { return 'granted'; },
    async createWritable() { throw new Error('disk full'); },
  });
  g3.prompt = () => 'fallback test';
  let downloadTriggered = false;
  const origCreateElement = g3.document.createElement;
  g3.document.createElement = function (tag) {
    const el = origCreateElement(tag);
    const origClick = el.click.bind(el);
    el.click = function () { if (el.download === 'data.json') downloadTriggered = true; origClick(); };
    return el;
  };
  try { await g3.publishData(); } catch (e) { check('publishData() write-failure fallback does not throw', false, e.stack); }
  check('a non-cancel write failure falls back to the classic download', downloadTriggered === true);
  check('a non-cancel write failure still commits the publish (timestamp/changelog)', !!g3.lastPublishedAt && g3.publishLog.length === 1);

  // ---- Unsupported browser (no showSaveFilePicker) uses the classic download, unchanged ----
  const g4 = makeSandbox(); // makeSandbox() never sets window.showSaveFilePicker
  check('unsupported-browser sandbox has no showSaveFilePicker', !g4.window.showSaveFilePicker);
  g4.prompt = () => 'plain download';
  try { await g4.publishData(); } catch (e) { check('publishData() unsupported-browser path does not throw', false, e.stack); }
  check('unsupported browser still successfully publishes (fallback path)', !!g4.lastPublishedAt);

  // ---- resetPublishFileHandle ----
  const g5 = makeSandbox();
  g5.PUBLISH_FILE_HANDLE = makeFakeHandle('granted');
  g5.confirm = () => false;
  g5.resetPublishFileHandle();
  check('resetPublishFileHandle does nothing if the confirm is declined', g5.PUBLISH_FILE_HANDLE !== null);
  g5.confirm = () => true;
  g5.resetPublishFileHandle();
  check('resetPublishFileHandle clears the cached handle when confirmed', g5.PUBLISH_FILE_HANDLE === null);

  // ===========================================================================
  // 14. A tab restored from bfcache (rather than truly re-run from scratch)
  //     must snap back to the current week/month, not resume wherever it was
  //     navigated to before — that's the "reload always lands on an old week"
  //     bug: bfcache resumes the exact in-memory wkOffset instead of
  //     recomputing it.
  // ===========================================================================
  const g6 = makeSandbox();
  check('a pageshow listener was registered', typeof g6.__on_pageshow === 'function');
  g6.wkOffset = 13; g6.monthOffset = 4; g6.showExport = true;
  g6.__on_pageshow({ persisted: false });
  check('a non-bfcache pageshow (persisted:false) leaves the current week alone', g6.wkOffset === 13);
  g6.__on_pageshow({ persisted: true });
  check('a bfcache-restored pageshow (persisted:true) resets to the current week', g6.wkOffset === 0);
  check('a bfcache-restored pageshow also resets the current month', g6.monthOffset === 0);
  check('a bfcache-restored pageshow re-renders without throwing', capturedHTML.length > 0);

  // ===========================================================================
  // 15. A stale, lazily-created all-'off' week sitting in this browser's own
  //     saved state must not overwrite a colleague's freshly-published real
  //     data for that same week (TODO.md #2 — data-loss bug).
  //
  //     Repro sequence: this browser once viewed a week before anyone had
  //     published real data for it, so getSched() lazily filled it with an
  //     all-'off' skeleton and a subsequent render()->saveState() persisted
  //     it. Later, a colleague published real data for that same week. On
  //     this browser's next boot, bootAndRender() applies the fetched remote
  //     state first, then loadState() re-applies this browser's own saved
  //     state on top -- if that saved state still carries the stale
  //     skeleton, it silently clobbers the real data that was just fetched.
  // ===========================================================================
  const g7 = makeSandbox();
  const o7 = 20;
  const wk7 = g7.wkKey(o7);
  g7.getSched(o7); // merely viewing the week, before anyone published real data for it
  const exported7 = g7.exportState();
  check('a lazily-created all-off week is not included in the saved/published state', !exported7.schedule[wk7]);

  const remoteWeek7 = {};
  g7.MEMBERS.forEach((m) => { remoteWeek7[m.id] = Array(5).fill('off'); });
  remoteWeek7.karen[0] = 'vacation'; // a colleague's real, since-published data
  const remoteState7 = { schedule: {} };
  remoteState7.schedule[wk7] = remoteWeek7;

  const g8 = makeSandbox();
  g8.applyState(remoteState7);
  check('the freshly-fetched published data is visible before local state is applied', g8.schedule[wk7].karen[0] === 'vacation');
  g8.applyState(exported7); // this browser's own saved state, re-applied exactly like loadState() does
  check("a stale local skeleton from before the colleague's publish must not erase their real vacation day", g8.schedule[wk7].karen[0] === 'vacation');

  // ===========================================================================
  // 16. Unlocking a week must survive a reload (TODO.md #3). applyState()'s
  //     lockedWeeks handling only ever ADDED weeks from incoming state into
  //     the existing Set, so an explicit unlock could never actually stick:
  //     on the next boot, bootAndRender() applies the (still-locked) remote
  //     state before this browser's own saved (unlocked) state, and an
  //     add-only merge has no way to remove what remote just added back in.
  // ===========================================================================
  const g9 = makeSandbox();
  const wkLock = g9.wkKey(-5);
  g9.applyState({ lockedWeeks: [wkLock] }); // currently-published data.json has this week locked
  check('remote publish locks the week as expected', g9.lockedWeeks.has(wkLock));

  g9.wkOffset = -5;
  g9.toggleLock(); // this browser explicitly unlocks it
  check('toggleLock() unlocks the week locally', !g9.lockedWeeks.has(wkLock));
  const exportedLock = g9.exportState();
  check('the unlock is correctly excluded from the saved local state', !exportedLock.lockedWeeks.includes(wkLock));

  const g10 = makeSandbox();
  g10.applyState({ lockedWeeks: [wkLock] }); // still-published (not yet republished with the unlock)
  check('the freshly-fetched remote lock is visible before local state is applied', g10.lockedWeeks.has(wkLock));
  g10.applyState(exportedLock); // this browser's own saved state, re-applied exactly like loadState() does
  check('an explicit local unlock must survive being merged with the still-locked remote state', !g10.lockedWeeks.has(wkLock));

  // ===========================================================================
  // 17. buildSuggestion()/regenSuggestion() must not erase a pre-existing
  //     vacation/sick/otherteam day when generating next week's rotation
  //     (TODO.md #4). buildSuggestion() built the whole next week from
  //     scratch starting at all-'off' and unconditionally overwrote
  //     schedule[wkKey(next)] with it, silently wiping out any day already
  //     stamped by the vacation log -- and regenSuggestion() made it worse
  //     by deleting the week outright before rebuilding.
  // ===========================================================================
  const g11 = makeSandbox();
  const o11 = 100;
  const next11 = o11 + 1;
  const wkNext11 = g11.wkKey(next11);

  // Carlos already has a vacation logged for Monday of next week (stamped into
  // schedule ahead of time, exactly like the vacation log does) before anyone
  // clicks "Suggest next week".
  g11.schedule[wkNext11] = {};
  g11.MEMBERS.forEach((m) => { g11.schedule[wkNext11][m.id] = Array(5).fill('off'); });
  g11.schedule[wkNext11].carlos[0] = 'vacation';

  g11.buildSuggestion(o11);
  check('buildSuggestion preserves a pre-existing vacation day instead of erasing it', g11.schedule[wkNext11].carlos[0] === 'vacation');

  // Regenerating the suggestion (re-rolling the random WFH picks) must not
  // erase the same pre-existing vacation day either.
  g11.wkOffset = next11;
  g11.regenSuggestion();
  check('regenSuggestion preserves the same pre-existing vacation day across a re-roll', g11.schedule[wkNext11].carlos[0] === 'vacation');

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log('\n' + passes + ' passed, ' + failures + ' failed.');
  if (failures > 0) {
    console.log('\ntest-smoke.js FAILED — do not publish/push until this is green.');
    process.exit(1);
  } else {
    console.log('\ntest-smoke.js PASSED.');
    process.exit(0);
  }
})();
