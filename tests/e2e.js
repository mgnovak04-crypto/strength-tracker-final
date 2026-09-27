#!/usr/bin/env node
// End-to-end tests for the built app (run `node build.js` first, or `npm test`).
// Serves the repo over HTTP so the service worker, manifest and offline mode are exercised for real.
// Needs Playwright; set CHROME_PATH to a Chromium binary if Playwright's bundled browser isn't installed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
// NET.slow stalls the app page (simulates one bar of gym signal); NET.override serves alternate content
const NET = { slow: false, override: {} };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  if (NET.override[p] !== undefined) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(NET.override[p]); }
  if (NET.slow && p.endsWith('index.html')) { setTimeout(() => { try { res.writeHead(504); res.end(); } catch (e) {} }, 20000); return; }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('PASS ' + name); }
  catch (e) { failed++; results.push('FAIL ' + name + '\n     ' + (e && e.message || e).split('\n')[0]); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const SHORT = pkg.version.split('.').slice(0, 2).join('.');

  // Fresh iPhone-sized context per test group so storage never leaks between tests.
  const fresh = async (seed) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (seed) { await page.evaluate(seed); await page.reload({ waitUntil: 'networkidle' }); }
    await page.waitForSelector('.tabs');
    return { ctx, page, errors };
  };
  const text = (page) => page.evaluate(() => document.body.innerText);
  const tab = async (page, name) => { await page.locator('.tab', { hasText: name }).click(); await page.waitForTimeout(250); };
  const openDay = async (page, name) => { await page.locator('.card h3', { hasText: name }).first().click(); await page.waitForSelector('.ss-label'); };
  const back = async (page) => { await page.locator('button', { hasText: 'Back' }).first().click(); await page.waitForSelector('.tabs'); };
  // Fill and log one set in the currently open exercise (kg 40 if there's a kg box, reps 10)
  const logOpenSet = async (page, idx = 0) => {
    const row = page.locator('.log-area .set-row').nth(idx);
    const inputs = row.locator('input');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) await inputs.nth(i).fill(n > 1 && i === 0 ? '40' : '10');
    if (await row.locator('select').count()) await row.locator('select').selectOption('M');
    await row.locator('button', { hasText: 'Log' }).click();
  };
  // First superset (rest > 0, 2+ exercises) of Full Body A at 45 min
  const firstSuperset = (page) => page.evaluate(() => { const d = trimDay(getProgramDays(ld('phase', 1))[0], 'm45'); const ss = d.supersets.find(s => s.rest > 0 && s.exercises.length > 1); return { a: exMap[ss.exercises[0].eid].n, b: exMap[ss.exercises[1].eid].n, rest: ss.rest }; });

  // ---------------- installable app / offline ----------------
  await test('built page is pre-compiled (no in-browser Babel, React served locally)', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert(!/babel/i.test(html.split('<script>')[0]) && !html.includes('text/babel'), 'Babel still referenced');
    assert(!html.includes('unpkg.com'), 'still loads from unpkg CDN');
    assert(html.includes('vendor/react.production.min.js'), 'React not served locally');
    assert(!html.includes('__VERSION'), 'unreplaced version placeholder');
  });

  await test('manifest, home-screen icon and launch screens are all served', async () => {
    const { ctx, page } = await fresh();
    const info = await page.evaluate(async () => {
      const m = document.querySelector('link[rel="manifest"]');
      const man = await (await fetch(m.href)).json();
      const icon = await fetch(document.querySelector('link[rel="apple-touch-icon"]').href);
      const splashes = [...document.querySelectorAll('link[rel="apple-touch-startup-image"]')];
      const statuses = await Promise.all(splashes.map(l => fetch(l.href).then(r => r.status)));
      return { name: man.name, display: man.display, icons: man.icons.length, iconStatus: icon.status, iconType: icon.headers.get('content-type'), splashCount: splashes.length, splashBad: statuses.filter(s => s !== 200).length };
    });
    assert(info.name === 'IronClad Pro' && info.display === 'standalone', 'manifest name/display wrong: ' + JSON.stringify(info));
    assert(info.icons >= 3, 'manifest icons missing');
    assert(info.iconStatus === 200 && info.iconType === 'image/png', 'apple-touch-icon not served');
    assert(info.splashCount >= 10 && info.splashBad === 0, `launch screens: ${info.splashCount} links, ${info.splashBad} broken`);
    await ctx.close();
  });

  await test('service worker installs and the app opens with NO connection', async () => {
    const { ctx, page } = await fresh();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' }); // now controlled by the service worker
    assert(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker not controlling the page');
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.tabs', { timeout: 8000 });
    assert((await text(page)).includes('Workout'), 'offline relaunch did not render the app');
    await openDay(page, 'Full Body A'); // and a workout still opens offline
    await ctx.close();
  });

  await test('shows an "Updated" toast once after a new version lands', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_appVersion', '0.0.1')); // pretend an older version ran before
    assert((await text(page)).includes('Updated to v' + SHORT), 'no update toast');
    await ctx.close();
  });

  // ---------------- every session is full-body ----------------
  await test('every day x phase x session length trains all 9 muscle groups', async () => {
    const { ctx, page } = await fresh();
    const out = await page.evaluate(() => {
      const bad = [];
      for (const ph of [1, 2, 3, 4]) for (const mode of ['m35', 'm45', 'full']) for (const raw of getProgramDays(ph)) {
        const d = trimDay(raw, mode); const c = sessionCoverage(d);
        const needDirect = mode === 'm35' ? ['Quads', 'Hamstrings', 'Glutes', 'Calves', 'Chest', 'Back', 'Core'] : MUSCLE_GROUPS;
        const missDirect = needDirect.filter(g => !c.direct.includes(g));
        const missAny = MUSCLE_GROUPS.filter(g => !c.any.includes(g));
        if (missDirect.length || missAny.length) bad.push(`P${ph} ${mode} ${raw.name}: direct-missing ${missDirect} any-missing ${missAny}`);
      }
      return bad;
    });
    assert(out.length === 0, out.slice(0, 4).join(' | '));
    await ctx.close();
  });

  await test('session lengths trim progressively and fit their time budgets', async () => {
    const { ctx, page } = await fresh();
    const out = await page.evaluate(() => {
      const bad = []; const B = { m35: [28, 36], m45: [38, 46], full: [50, 65] };
      for (const ph of [1, 2, 3, 4]) for (const raw of getProgramDays(ph)) {
        const n = {}; for (const m of ['m35', 'm45', 'full']) { const d = trimDay(raw, m); n[m] = d.supersets.reduce((a, s) => a + s.exercises.length, 0); const t = estDayMinutes(d); if (t < B[m][0] || t > B[m][1]) bad.push(`P${ph} ${raw.name} ${m} ~${t}m`); }
        if (!(n.m35 < n.m45 && n.m45 < n.full)) bad.push(`P${ph} ${raw.name} counts ${JSON.stringify(n)}`);
      }
      return bad;
    });
    assert(out.length === 0, out.slice(0, 4).join(' | '));
    await ctx.close();
  });

  await test('day screen shows all 9 muscle groups worked', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Full Body B');
    const lit = await page.locator('.mchip.on').count();
    assert(lit === 9, `expected 9 lit muscle chips at 45 min, got ${lit}`);
    await ctx.close();
  });

  // ---------------- optional sessions ----------------
  await test('Core, Plyo and Band add-ons are listed and open', async () => {
    const { ctx, page, errors } = await fresh();
    for (const name of ['Core Focus', 'Plyo Power', 'Band Full Body']) { await openDay(page, name); await back(page); }
    assert(errors.length === 0, errors[0]);
    await ctx.close();
  });

  await test('Plyo warns to skip jumps when the knee check-in is 3+/5', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Plyo Power');
    const knee = page.locator('.pain-row').first().locator('.pain-dot');
    await knee.nth(3).click();
    assert((await text(page)).includes('skip the jumps today'), 'no warning at knee 3/5');
    await knee.nth(1).click();
    assert(!(await text(page)).includes('skip the jumps today'), 'warning shown at knee 1/5');
    await ctx.close();
  });

  await test('Band session: every exercise is band/bodyweight; tension logs and shows in the summary', async () => {
    const { ctx, page } = await fresh();
    const eqs = await page.evaluate(() => [1, 2, 3, 4].flatMap(ph => getBandDay(ph).supersets.flatMap(s => s.exercises.map(e => exMap[e.eid].eq))));
    assert(eqs.every(e => ['Band', 'Bodyweight', 'Wall', 'Towel Roll', 'Step'].includes(e)), 'band session needs other equipment: ' + [...new Set(eqs)]);
    await openDay(page, 'Band Full Body');
    const bandName = await page.evaluate(() => { const d = getBandDay(ld('phase', 1)); const e = d.supersets.slice(1).flatMap(s => s.exercises).find(x => exMap[x.eid].eq === 'Band'); return exMap[e.eid].n; });
    const row = page.locator('.ex-row', { hasText: bandName }).first();
    await row.click();
    const setRow = page.locator('.log-area .set-row').first();
    await setRow.locator('select').selectOption('M');
    await setRow.locator('input').last().fill('12');
    await setRow.locator('button', { hasText: 'Log' }).click();
    if (await page.locator('.rest-overlay').count()) await page.locator('.rest-overlay .rest-btn', { hasText: 'Skip' }).click();
    await page.waitForTimeout(300); // logging moves on to the next exercise, which collapses this row
    const summary = await page.locator('.ex-row', { hasText: bandName }).first().innerText();
    assert(summary.includes('Medium 12'), 'collapsed summary missing tension: ' + summary.replace(/\s+/g, ' '));
    await ctx.close();
  });

  // ---------------- core workout flow regressions ----------------
  await test('supersets run in rounds (A1 -> B1 -> rest) and the rest timer counts down', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Full Body A');
    const ss = await firstSuperset(page);
    await page.locator('.ex-row', { hasText: ss.a }).first().click();
    await logOpenSet(page);
    await page.waitForTimeout(500);
    assert(await page.locator('.rest-overlay').count() === 0, 'rested between A1 and B1');
    assert((await page.locator('.log-area').first().innerText()).includes(ss.b), 'did not move on to the second exercise of the superset');
    await logOpenSet(page);
    await page.waitForSelector('.rest-overlay');
    const a = parseInt(await page.locator('.rest-overlay .big').innerText());
    assert(Math.abs(a - ss.rest) <= 1, `rest ${a}s, block says ${ss.rest}s`);
    await page.waitForTimeout(3200);
    const b = parseInt(await page.locator('.rest-overlay .big').innerText());
    assert(b <= a - 2, `rest timer did not count down (${a} -> ${b})`);
    await page.locator('.rest-overlay .rest-btn', { hasText: 'Skip' }).click();
    assert((await page.locator('.log-area').first().innerText()).includes(ss.a), 'round 2 should start back on the first exercise');
    await ctx.close();
  });

  await test('New Week clears the plan and every add-on board', async () => {
    const { ctx, page } = await fresh(() => {
      localStorage.setItem('ic17_dayLog_FullBodyA_p1', JSON.stringify({ trapbar: [{ w: '60', r: '10', done: true }] }));
      localStorage.setItem('ic17_dayLog_PlyoPower_pplyo', JSON.stringify({ x: [{ r: '5', done: true }] }));
      localStorage.setItem('ic17_dayLog_BandFullBody_pband', JSON.stringify({ x: [{ r: '5', done: true }] }));
      localStorage.setItem('ic17_history', JSON.stringify([{ day: 'Full Body A', phase: 1, date: '2026-01-01', volume: 1, calories: 1, pct: 100 }]));
    });
    page.once('dialog', d => d.accept());
    await page.locator('button', { hasText: 'New Week' }).click();
    await page.waitForSelector('.tabs');
    await page.waitForTimeout(400);
    const left = await page.evaluate(() => ['FullBodyA_p1', 'PlyoPower_pplyo', 'BandFullBody_pband'].filter(k => localStorage.getItem('ic17_dayLog_' + k)));
    assert(left.length === 0, 'not cleared: ' + left);
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_history')).length === 1), 'history was wiped');
    await ctx.close();
  });

  await test('Copy Backup then Paste Backup restores data on a wiped device', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_history', JSON.stringify([{ day: 'Full Body A', phase: 1, date: '2026-02-02', volume: 5, calories: 5, pct: 100 }])));
    await tab(page, 'Settings');
    await page.locator('button', { hasText: 'Copy Backup' }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip.includes('ic17_history'), 'clipboard backup missing data');
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await tab(page, 'Settings');
    await page.locator('button', { hasText: 'Paste Backup' }).click();
    await page.locator('textarea').fill(clip);
    page.once('dialog', d => d.accept());
    await page.locator('button', { hasText: 'Restore From Paste' }).click();
    await page.waitForTimeout(1500);
    await page.waitForSelector('.tabs');
    const h = await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_history') || '[]'));
    assert(h.length === 1 && h[0].date === '2026-02-02', 'restore failed: ' + JSON.stringify(h));
    await ctx.close();
  });

  await test('every tab renders without errors on a fresh install', async () => {
    const { ctx, page, errors } = await fresh();
    for (const t of ['Progress', 'Library', 'Settings', 'Workout']) await tab(page, t);
    assert(errors.length === 0, errors[0]);
    assert((await text(page)).includes('v' + SHORT), 'version not shown');
    await ctx.close();
  });

  // ---------------- review fixes ----------------
  await test('logging set 2 before set 1 no longer breaks the app, and old broken logs heal', async () => {
    const { ctx, page, errors } = await fresh();
    await openDay(page, 'Full Body A');
    const name = await page.evaluate(() => { const d = trimDay(getProgramDays(ld('phase', 1))[0], ld('sessionLen', 'm45')); return exMap[d.supersets.find(s => s.rest > 0).exercises.find(e => exMap[e.eid].t === 'w').eid].n; });
    await page.locator('.ex-row', { hasText: name }).first().click();
    const second = page.locator('.log-area .set-row').nth(1);
    await second.locator('input').nth(0).fill('50'); await second.locator('input').nth(1).fill('8');
    await second.locator('button', { hasText: 'Log' }).click();
    if (await page.locator('.rest-overlay').count()) await page.locator('.rest-overlay .rest-btn', { hasText: 'Skip' }).click();
    const holes = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('ic17_dayLog_FullBodyA_p1') || '{}')).some(a => a.some(x => !x)));
    assert(!holes, 'set list saved with gaps');
    // a log saved by an older build with a gap in it
    await page.evaluate(() => localStorage.setItem('ic17_dayLog_FullBodyA_p1', JSON.stringify({ trapbar: [null, { w: '60', r: '10', done: true }] })));
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.tabs');
    await openDay(page, 'Full Body A');
    assert(errors.length === 0, errors[0]);
    await ctx.close();
  });

  await test('a crash shows a recovery screen (not a blank page)', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.setItem('ic17_weekDone', 'null'));
    await page.reload({ waitUntil: 'networkidle' });
    const t = await text(page);
    assert(t.includes('Something went wrong') && t.includes('Copy Backup') && t.includes('Try Again'), 'no recovery screen: ' + t.slice(0, 80));
    await ctx.close();
  });

  await test('restore refuses a malformed backup and changes nothing', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_history', JSON.stringify([{ day: 'Full Body A', phase: 1, date: '2026-03-01', pct: 100 }])));
    let dialogs = 0; page.on('dialog', d => { dialogs++; d.dismiss(); });
    await tab(page, 'Settings');
    await page.locator('button', { hasText: 'Paste Backup' }).click();
    await page.locator('textarea').fill(JSON.stringify({ ic17_history: '{}' }));
    await page.locator('button', { hasText: 'Restore From Paste' }).click();
    await page.waitForTimeout(300);
    assert((await text(page)).includes('should be a list'), 'no validation message');
    assert(dialogs === 0, 'asked to confirm an invalid backup');
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_history')).length === 1), 'data changed');
    await ctx.close();
  });

  await test('restore compares backup vs phone, warns about newer data, and can be undone', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_history', JSON.stringify([{ day: 'Full Body B', phase: 1, date: '2026-03-10', pct: 100 }])));
    await tab(page, 'Settings');
    await page.locator('button', { hasText: 'Paste Backup' }).click();
    await page.locator('textarea').fill(JSON.stringify({ ic17_history: JSON.stringify([{ day: 'Full Body A', phase: 1, date: '2026-02-01', pct: 100 }, { day: 'Full Body C', phase: 1, date: '2026-01-20', pct: 100 }]) }));
    let msg = '';
    page.once('dialog', d => { msg = d.message(); d.accept(); });
    await page.locator('button', { hasText: 'Restore From Paste' }).click();
    await page.waitForTimeout(1500); await page.waitForSelector('.tabs');
    assert(msg.includes('Backup: 2 workouts') && msg.includes('This phone: 1 workout') && msg.includes('NEWER'), 'confirm message: ' + msg);
    assert(await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_history')).length === 2), 'restore not applied');
    await tab(page, 'Settings');
    page.once('dialog', d => d.accept());
    await page.locator('button', { hasText: 'Undo Last Restore' }).click();
    await page.waitForTimeout(1500); await page.waitForSelector('.tabs');
    const h = await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_history')));
    assert(h.length === 1 && h[0].date === '2026-03-10', 'undo did not bring the phone data back');
    await ctx.close();
  });

  await test('first launch offers to restore a backup; "starting fresh" hides it for good', async () => {
    const { ctx, page } = await fresh();
    assert((await text(page)).includes('Moving from another copy'), 'no first-run restore card');
    await page.locator('button', { hasText: "I'm starting fresh" }).click();
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.tabs');
    assert(!(await text(page)).includes('Moving from another copy'), 'card came back');
    await ctx.close();
    const seeded = await fresh(() => localStorage.setItem('ic17_history', JSON.stringify([{ day: 'Full Body A', phase: 1, date: '2026-03-01', pct: 100 }])));
    assert(!(await text(seeded.page)).includes('Moving from another copy'), 'card shown to an existing user');
    await seeded.ctx.close();
  });

  await test('timed exercises in minutes show minutes ("3 min easy" = Start 3:00)', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Full Body A');
    await page.locator('.ex-row', { hasText: 'Rowing Machine' }).first().click();
    const t = await page.locator('.log-area .cd-timer').first().innerText();
    assert(t.includes('3:00'), 'timer shows: ' + t);
    await ctx.close();
  });

  await test('Plyo also warns when calf tightness is 3+/5', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Plyo Power');
    await page.locator('.pain-row').nth(1).locator('.pain-dot').nth(3).click();
    assert((await text(page)).includes('Calf tightness 3/5'), 'no calf warning');
    await ctx.close();
  });

  await test('weak signal: once installed the app opens instantly even if the network stalls', async () => {
    const { ctx, page } = await fresh();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' });
    NET.slow = true;
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.tabs', { timeout: 15000 });
    const ms = Date.now() - t0;
    NET.slow = false;
    assert(ms < 4000, `took ${ms}ms with a stalled network`);
    await ctx.close();
  });

  await test('a new version installs in the background and offers a reload', async () => {
    const { ctx, page } = await fresh();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' });
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    NET.override['/sw.js'] = sw.replace(/const CACHE = '([^']+)'/, "const CACHE = '$1-next'");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await page.waitForSelector('.update-pill', { timeout: 15000 });
    await page.locator('.update-pill').click();
    await page.waitForSelector('.tabs');
    delete NET.override['/sw.js'];
    await ctx.close();
  });

  await test('finished sessions record the training phase (for Plyo/Band history)', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_phase', '2'));
    await openDay(page, 'Core Focus');
    await page.locator('button', { hasText: 'Save Workout' }).click();
    await page.waitForTimeout(400);
    const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_history'))[0]);
    assert(rec && rec.trainPhase === 2 && rec.phase === 'core', 'record: ' + JSON.stringify(rec));
    await ctx.close();
  });

  await test('optional sessions fit an add-on slot (Core ~35, Plyo and Band under 40 min)', async () => {
    const { ctx, page } = await fresh();
    const t = await page.evaluate(() => [1, 2, 3, 4].flatMap(ph => [['core', estDayMinutes(getCoreDay())], ['plyo', estDayMinutes(getPlyoDay(ph))], ['band', estDayMinutes(getBandDay(ph))]]));
    const bad = t.filter(([, m]) => m > 40 || m < 22);
    assert(bad.length === 0, 'out of range: ' + JSON.stringify(bad));
    await ctx.close();
  });

  await test('rest setting really scales the rest timer and the block header ("Longer" = 1.5x)', async () => {
    const { ctx, page } = await fresh();
    await tab(page, 'Settings');
    await page.locator('button', { hasText: 'Longer' }).click();
    await tab(page, 'Workout');
    await openDay(page, 'Full Body A');
    const ss = await firstSuperset(page);
    const want = Math.round(ss.rest * 1.5);
    assert((await text(page)).includes('Rest: ' + want + 's'), 'block header not scaled');
    await page.locator('.ex-row', { hasText: ss.a }).first().click();
    await logOpenSet(page); await page.waitForTimeout(300); await logOpenSet(page);
    await page.waitForSelector('.rest-overlay');
    const shown = parseInt(await page.locator('.rest-overlay .big').innerText());
    assert(Math.abs(shown - want) <= 1, `rest ${shown}s, expected ~${want}s`);
    await ctx.close();
  });

  // ---------------- release-review fixes ----------------
  await test('swaps: no duplicate rows from old swaps, swapping back really undoes, deleted targets fall back', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_swaps', JSON.stringify({ tke: 'shortarcext', calfstand: 'custom_gone' })));
    await openDay(page, 'Full Body A');
    const names = await page.locator('.ex-row .ex-name').allInnerTexts();
    assert(names.filter(n => n.includes('Short-Arc')).length <= 1, 'duplicate Short-Arc rows: ' + names.join(','));
    assert(names.some(n => n.includes('Terminal Knee')), 'swap onto an exercise already in the day should be ignored');
    assert(names.some(n => n.includes('Standing Calf')), 'swap to a missing exercise should fall back to the original');
    // swap Rope Pushdown -> something else, then back
    await page.locator('.ex-row', { hasText: 'Rope Pushdown' }).first().click();
    await page.locator('button', { hasText: 'Swap' }).first().click();
    const opt = page.locator('div[style*="cursor: pointer"]', { hasText: 'Overhead Tricep Extension' }).first();
    await opt.click(); await page.waitForTimeout(200);
    assert((await page.locator('.ex-row .ex-name').allInnerTexts()).some(n => n.includes('Overhead Tricep')), 'swap did not apply');
    // the row stays open after a swap, so its Swap button is right there
    await page.locator('button', { hasText: 'Swap' }).first().click();
    await page.locator('div', { hasText: /^↺ Back to Rope Pushdown$/ }).first().click();
    await page.waitForTimeout(200);
    assert((await page.locator('.ex-row .ex-name').allInnerTexts()).some(n => n.includes('Rope Pushdown')), 'swap back did not restore');
    const sw = await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_swaps')));
    assert(!('ropepush' in sw) && !('ohext' in sw), 'swap map not cleaned: ' + JSON.stringify(sw));
    await ctx.close();
  });

  await test('Rest ON/OFF mid-workout keeps you in the workout and the session clock running', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Full Body A');
    await page.waitForTimeout(2200);
    await page.locator('button', { hasText: 'Rest: ON' }).click();
    await page.waitForTimeout(400);
    assert(await page.locator('button', { hasText: 'Rest: OFF' }).count() === 1, 'toggle did not flip');
    const clock = await page.locator('.session-timer').innerText();
    assert(clock !== '0:00' && (await text(page)).includes('Pre-Workout Check-In'), 'left the workout / clock reset: ' + clock);
    await ctx.close();
  });

  await test('progress never shows over 100% (old boards, sets lowered below logged)', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17_dayLog_FullBodyA_p1', JSON.stringify({ kneetowall: [1, 2, 3, 4].map(() => ({ w: '', r: '10', done: true })) })));
    const pctText = await page.locator('.card', { has: page.locator('h3', { hasText: 'Full Body A' }) }).innerText();
    const m = pctText.match(/(\d+)%/);
    assert(!m || parseInt(m[1]) <= 100, 'day card shows ' + (m && m[0]));
    await openDay(page, 'Full Body A');
    const row = await page.locator('.ex-row', { hasText: 'Knee-to-Wall' }).first().innerText();
    assert(!/\d{3}%/.test(row) && row.includes('✓'), 'row: ' + row.replace(/\s+/g, ' '));
    await ctx.close();
  });

  await test('loaded step-ups/heel drops/carries have a kg box; KB EMOM gets a countdown', async () => {
    const { ctx, page } = await fresh();
    await openDay(page, 'Full Body B');
    await page.locator('.ex-row', { hasText: 'Low Box Step-Up' }).first().click();
    assert(await page.locator('.log-area input[placeholder="kg"]').count() > 0, 'step-up has no kg box');
    await back(page);
    await openDay(page, 'Full Body C');
    await page.locator('.ex-row', { hasText: 'Kettlebell Swing' }).first().click();
    const t = await page.locator('.log-area').first().innerText();
    assert(/Start [23]:00/.test(t), 'KB EMOM has no countdown: ' + t.replace(/\s+/g, ' ').slice(0, 120));
    await ctx.close();
  });

  await test('backups from older versions (text numbers, measurement lists) restore and are normalised', async () => {
    const { ctx, page } = await fresh();
    await tab(page, 'Settings');
    await page.locator('button', { hasText: 'Paste Backup' }).click();
    await page.locator('textarea').fill(JSON.stringify({ ic17_bodyweight: '"82.5"', ic17_measurements: JSON.stringify([{ date: '2025-01-01', waist: 90 }]), ic17_history: '[]' }));
    page.once('dialog', d => d.accept());
    await page.locator('button', { hasText: 'Restore From Paste' }).click();
    await page.waitForTimeout(1500); await page.waitForSelector('.tabs');
    const bw = await page.evaluate(() => JSON.parse(localStorage.getItem('ic17_bodyweight')));
    assert(bw === 82.5, 'bodyweight not restored as a number: ' + JSON.stringify(bw));
    await ctx.close();
  });

  await test('restore undo expires once you train again; the crash screen has no one-tap wipe', async () => {
    const { ctx, page } = await fresh(() => localStorage.setItem('ic17__preRestore', JSON.stringify({ at: 'x', prev: { ic17_history: null } })));
    await openDay(page, 'Core Focus');
    await page.locator('button', { hasText: 'Save Workout' }).click();
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => localStorage.getItem('ic17__preRestore') === null), 'snapshot survived a new workout');
    await page.evaluate(() => { localStorage.setItem('ic17__preRestore', JSON.stringify({ at: 'x', prev: {} })); localStorage.setItem('ic17_weekDone', 'null'); });
    await page.reload({ waitUntil: 'networkidle' });
    const t = await text(page);
    assert(t.includes('Something went wrong') && !t.includes('Undo Last Restore'), 'crash screen offers undo');
    await ctx.close();
  });

  await test('Progress: recent lifts lead 1RM trends; weekly volume counts sets actually done', async () => {
    const { ctx, page } = await fresh(() => {
      const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      const old = Array.from({ length: 30 }, (_, i) => ({ date: '2025-0' + (1 + (i % 9)) + '-1' + (i % 9), e1rm: 60 + i, w: 50, r: 5 }));
      const log = {}; ['bbench', 'nordicham', 'johnsoncalf', 'cablefly', 'skierswing', 'farmerwalk', 'tbarrow', 'dbohp'].forEach(k => { log[k] = old; });
      log.revlunge = [{ date: d(9), e1rm: 50, w: 20, r: 10 }, { date: d(2), e1rm: 54, w: 22, r: 10 }];
      localStorage.setItem('ic17_e1rmLog', JSON.stringify(log));
      localStorage.setItem('ic17_history', JSON.stringify([{ day: 'Full Body A', phase: 1, trainPhase: 1, date: d(1), pct: 60, doneSets: { latraise: 3 } }]));
    });
    await tab(page, 'Progress');
    const t = await text(page);
    assert(t.includes('Reverse Lunge'), 'current lift missing from 1RM trends');
    const vol = t.slice(t.indexOf('Muscle Group Volume'));
    assert(/Shoulders\s*3/.test(vol) && !/Glutes/.test(vol.split('Strength Progression')[0] || vol), 'volume not from logged sets: ' + vol.slice(0, 200).replace(/\s+/g, ' '));
    await ctx.close();
  });

  await test('service worker cache name carries a content hash (any change reaches phones)', async () => {
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    assert(/const CACHE = 'ironclad-[\d.]+-[0-9a-f]{10}'/.test(sw), 'no content hash in cache name');
  });

  await browser.close();
  server.close();
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
