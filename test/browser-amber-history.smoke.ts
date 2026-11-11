// Full-page regression with genuine Nostr signatures and isolated in-memory server data.
// Captures the actual outgoing intent and returns through released Amber parsing.
// Cannot test Android's external-app resolver or physical approval UI.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAmber, amberReturn } from './helpers/amber-contract';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { Word5Service, getCurrentPeriodId } from '../src/word5';
const { chromium } = await import(process.env.WORD5_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dir, '..');
const service = new Word5Service({ rootDir: root, dbPath: ':memory:', relays: [], gamestrRelays: [] });
const secret = generateSecretKey(), pubkey = getPublicKey(secret), other = getPublicKey(generateSecretKey());
const period = getCurrentPeriodId();
for (const p of [period - 2, period - 1]) service.socialHistory.archive(finalizeEvent({ kind: 1,
  created_at: p * 86400 + 10, tags: [['t', 'word5'], ['puzzle', String(p % 1000)], ['period', String(p)], ['result', '2']], content: '' }, secret));
const bundle = await Bun.build({ entrypoints: [resolve(root, 'node_modules/nostr-tools/lib/esm/index.js')], target: 'browser' });
if (!bundle.success) throw new Error(String(bundle.logs));
const moduleText = await bundle.outputs[0].text();
let unavailable = false;
let historyDelay = 0;
const server = Bun.serve({ port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/api/player-history') { if (historyDelay) await Bun.sleep(historyDelay); return unavailable ? new Response('{}', { status: 503 }) : Response.json(service.playerHistory(url.searchParams.get('pubkey')!)); }
  if (url.pathname === '/api/completion') {
    try { return Response.json(service.complete((await req.json()).event)); }
    catch (error) { return Response.json({ ok: false, error: String(error) }, { status: 400 }); }
  }
  if (url.pathname.startsWith('/api/')) return Response.json({ ok: true, count: 0, rows: [] });
  const file = resolve(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  return new Response(Bun.file(file), { headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'text/plain' } });
} });
const browser = await chromium.launch({ headless: true,
  ...(process.env.WORD5_BROWSER_EXECUTABLE ? { executablePath: process.env.WORD5_BROWSER_EXECUTABLE } : {}) });
const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); console.log(`PASS ${message}`); };
const base = String(server.url);
const outgoing = new WeakMap<any, string>();
async function openAmber(page: any) {
  outgoing.delete(page);
  await page.locator('#amberRequest button').first().click();
  for (let i = 0; i < 100 && !outgoing.has(page); i++) await page.waitForTimeout(10);
  if (!outgoing.has(page)) throw new Error('No outgoing Android intent captured');
  return outgoing.get(page)!;
}
async function newPhone() {
  const context = await browser.newContext();
  await context.route('https://esm.sh/**', route => route.fulfill({ body: moduleText, contentType: 'text/javascript' }));
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  cdp.on('Page.frameRequestedNavigation', (e: any) => { if (e.url.startsWith('intent:')) outgoing.set(page, e.url); });
  page.on('pageerror', error => console.error('PAGE ERROR', error));
  await page.goto(base);
  await page.waitForFunction(() => (window as any).NostrSession?.getPlayer() && (window as any).Word5App?.recordCompletedScore);
  return { context, page };
}
async function connect(page: any) {
  await page.evaluate(() => (window as any).AmberSigner.login());
  check(await page.evaluate(() => !localStorage.getItem('word5-amber-pending-v1')), 'login does not launch or persist a request without explicit Open Amber click');
  await openAmber(page);
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
  check(pending.type === 'get_public_key', 'explicit click creates correlated login request');
  await page.goto('about:blank');
  await page.goto(amberReturn(outgoing.get(page)!, pubkey));
  await page.waitForFunction(pk => (window as any).NostrSession?.getPlayer()?.linked_pubkey === pk &&
    JSON.parse(localStorage.getItem('words-game') || '{}').stats?.played === 2, pubkey);
}
try {
  const { context, page } = await newPhone();
  await connect(page);
  check(await page.evaluate(() => !location.hash && (window as any).NostrSession.getPlayer().auth_mode === 'amber'), 'Amber callback survives full navigation, selects account, strips callback');
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('words-game')!).stats.streak === 2), 'fresh browser restores server-backed two-game streak');
  check(await page.locator('#amberConnected').textContent() === 'Connected with Amber. You’re ready to play.', 'successful login shows a clear connection confirmation');
  // Real same-document return: Android can bring back the existing browser tab.
  await page.evaluate(() => { (window as any).__signedResult = null;
    void (window as any).AmberSigner.signEvent({ kind: 1, created_at: 122, tags: [['x', '?&+=']], content: 'Same tab? & + %26 🧡' })
      .then((e: any) => { (window as any).__signedResult = e; }); });
  const existingIntent = await openAmber(page);
  const existingEvent = finalizeEvent(parseAmber(existingIntent).event, secret);
  await page.evaluate(url => {
    location.hash = new URL(url).hash;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, amberReturn(existingIntent, existingEvent.sig, existingEvent));
  await page.waitForFunction(id => (window as any).__signedResult?.id === id, existingEvent.id);
  check(await page.evaluate(() => !location.hash && !localStorage.getItem('word5-amber-pending-v1') && !localStorage.getItem('word5-amber-returned-v1') && !document.getElementById('amberRequest')), 'same-tab generated return survives overlapping lifecycle events and resolves signature once');
  // Reject a cryptographically valid signature whose content differs from the requested event.
  await page.evaluate(() => { void (window as any).AmberSigner.signEvent({ kind: 1, created_at: 123, tags: [], content: 'expected' }).catch(() => {}); });
  await openAmber(page);
  const badPending = await page.evaluate(() => JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
  const badEvent = finalizeEvent({ ...badPending.event, content: 'altered' }, secret);
  await page.goto(amberReturn(outgoing.get(page)!, badEvent.sig, badEvent));
  await page.waitForFunction(() => document.getElementById('amberRequest')?.textContent?.includes('different or invalid'));
  check(await page.evaluate(pk => (window as any).NostrSession.getPlayer().linked_pubkey === pk, pubkey), 'tampered signed callback rejected without identity loss');
  await page.locator('#amberRequest button').click();
  await page.evaluate(() => { void (window as any).AmberSigner.signEvent({ kind: 1, created_at: 124, tags: [], content: 'cancel' }).catch(() => {}); });
  await page.locator('#amberRequest button').last().click();
  check(await page.evaluate(() => !document.getElementById('amberRequest') && !localStorage.getItem('word5-amber-pending-v1')), 'cancel clears pending request and permits retry');
  await page.evaluate(() => { void (window as any).AmberSigner.signEvent({ kind: 1, created_at: 125, tags: [['t', 'word5']], content: 'repeatable post' }).catch(() => {}); });
  await openAmber(page);
  const postRequest = await page.evaluate(() => JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
  const postSigned = finalizeEvent(postRequest.event, secret);
  await page.goto('about:blank');
  await page.goto(amberReturn(outgoing.get(page)!, postSigned.sig, postSigned));
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => (window as any).Word5App?.recordCompletedScore && localStorage.getItem('word5-amber-returned-v1'));
  const resumed = await page.evaluate(() => (window as any).AmberSigner.signEvent({ kind: 1, created_at: 135, tags: [['t', 'word5']], content: 'repeatable post' }));
  check(resumed.id === postSigned.id, 'approved public payload survives a regenerated timestamp without a signature loop');
  await page.locator('#amberRequest button').click();
  // Complete today's puzzle through the actual game UI handler, then sign via reload callback.
  await page.evaluate(() => (window as any).eval('state.currentGuess = state.targetWord; submitGuess();'));
  await page.waitForSelector('#amberRequest');
  await openAmber(page);
  const completion = await page.evaluate(() => JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
  check(completion.type === 'sign_event' && completion.pubkey === pubkey && completion.event.tags[0][1] === 'word5.completion.v1', 'completion requests correct preserved Amber account');
  const signed = finalizeEvent(completion.event, secret);
  await page.goto('about:blank');
  await page.goto(amberReturn(outgoing.get(page)!, signed.sig, signed));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').serverCompleted === true);
  check(service.playerHistory(pubkey).stats.streak === 3 && service.playerHistory(pubkey).stats.played === 3, 'signed completion resumes after reload and continues streak without duplicate win');
  await page.reload();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').serverCompleted === true);
  check(service.playerHistory(pubkey).stats.played === 3 && !await page.locator('#amberRequest').count(), 'reload of recorded completion never requests another signature');
  // A completely fresh browser for same pubkey restores completed status; stale totals are replaced.
  const second = await newPhone();
  await second.page.evaluate(() => localStorage.setItem('words-game', JSON.stringify({ stats: { played: 999, won: 999, streak: 999, maxStreak: 999 } })));
  await connectCompleted(second.page);
  check(await second.page.evaluate(() => JSON.parse(localStorage.getItem('words-game')!).stats.played === 3), 'server replaces conflicting high cache on another clean browser');
  // Let the server reveal an existing completion while a local guess is animating.
  await second.page.evaluate(() => {
    const p = (window as any).NostrSession.getPlayer();
    const cache = JSON.parse(localStorage.getItem('words-game')!);
    cache.gameOver = false; cache.serverCompleted = false; cache.guesses = []; cache.completedAt = 0;
    localStorage.setItem(`words-game:${p.linked_pubkey}`, JSON.stringify(cache));
  });
  historyDelay = 1000;
  await second.page.reload();
  await second.page.waitForFunction(() => (window as any).Word5App?.recordCompletedScore);
  await second.page.evaluate(() => (window as any).eval('state.currentGuess = state.targetWord; submitGuess();'));
  await second.page.waitForTimeout(2200);
  historyDelay = 0;
  check(await second.page.evaluate(() => JSON.parse(localStorage.getItem('words-game')!).stats.played === 3), 'server completion arriving during guess animation does not add a fourth win');
  unavailable = true;
  await second.page.reload();
  await second.page.waitForFunction(() => document.getElementById('scoreStatus')?.textContent?.includes('Server history unavailable'));
  check(await second.page.evaluate(() => JSON.parse(localStorage.getItem('words-game')!).stats.played === 3), 'server unavailable preserves same-account cached history');
  unavailable = false;
  await second.page.evaluate(key => (window as any).NostrSession.updatePlayer({ auth_mode: 'amber', linked_pubkey: key, linked_npub: 'other' }), other);
  await second.page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').stats?.played === 0);
  check(await second.page.evaluate(() => !(window as any).eval('state.gameOver')), 'identity switch isolates previous account game and totals');
  await second.page.evaluate(key => (window as any).NostrSession.updatePlayer({ linked_pubkey: key }), pubkey);
  await second.page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').stats?.played === 3);
  check(service.playerHistory(pubkey).stats.played === 3, 'switching back restores original history without resetting server');
  // A delayed separate Repair action must not apply A's statistics to B.
  historyDelay = 1000;
  await second.page.evaluate(() => {
    for (const id of ['profileRepairBtn', 'profileRepairStatus']) if (!document.getElementById(id)) {
      const el = document.createElement('button'); el.id = id; document.body.appendChild(el);
    }
    void (window as any).NostrUI.repairWord5StatsFromProfile();
  });
  await second.page.waitForTimeout(150);
  await second.page.evaluate(key => (window as any).NostrSession.updatePlayer({ linked_pubkey: key }), other);
  await second.page.waitForFunction(() => document.getElementById('profileRepairStatus')?.textContent?.includes('Account changed'));
  await second.page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').stats?.played === 0);
  check(await second.page.evaluate(() => JSON.parse(localStorage.getItem('words-game')!).stats.played === 0), 'separate delayed repair response cannot overwrite the newly active account');
  historyDelay = 0;
  await second.page.evaluate(key => (window as any).NostrSession.updatePlayer({ linked_pubkey: key }), pubkey);
  await second.page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').stats?.played === 3);
  // Bad correlation and expired returns must not select an unsolicited identity.
  await second.page.goto(`${base}?return=${crypto.randomUUID()}#amber-state=unknown&amber-result=${other}`);
  await second.page.waitForFunction(() => document.getElementById('amberRequest')?.textContent?.includes('Unrecognized or expired'));
  check(await second.page.evaluate(key => (window as any).NostrSession.getPlayer().linked_pubkey === key && !location.hash, pubkey), 'unsolicited callback is rejected and stripped without switching identity');
  await second.page.locator('#amberRequest button').click();
  await second.page.evaluate(() => (window as any).AmberSigner.login());
  await openAmber(second.page);
  const expired = await second.page.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('word5-amber-pending-v1')!); r.at = Date.now() - 16 * 60000;
    localStorage.setItem('word5-amber-pending-v1', JSON.stringify(r)); return r;
  });
  await second.page.goto(`${base}?return=${crypto.randomUUID()}#amber-state=${expired.id}&amber-result=${other}`);
  await second.page.waitForFunction(() => document.getElementById('amberRequest')?.textContent?.includes('Unrecognized or expired'));
  check(await second.page.evaluate(key => (window as any).NostrSession.getPlayer().linked_pubkey === key, pubkey), 'expired callback cannot replace preserved signer account');
  await callbackRaces();
  await context.close(); await second.context.close();
} finally { await browser.close(); server.stop(true); service.db.close(); }

async function connectCompleted(page: any) {
  await page.evaluate(() => (window as any).AmberSigner.login());
  await openAmber(page);
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('word5-amber-pending-v1')!));
  await page.goto('about:blank');
  await page.goto(amberReturn(outgoing.get(page)!, pubkey));
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('words-game') || '{}').serverCompleted === true);
}

async function callbackRaces() {
  const context = await browser.newContext();
  await context.route('**/amber-harness', route => route.fulfill({ body: '<html><body></body></html>', contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto(base + 'amber-harness');
  // Replace only the module-loading dependency to hold callback processing at its
  // actual await boundary; use real nostr-tools verification once released.
  await context.route('https://esm.sh/**', route => route.fulfill({ body: moduleText, contentType: 'text/javascript' }));
  await page.evaluate(async () => {
    const w = window as any;
    w.__tools = await import('https://esm.sh/nostr-tools@2?bundle');
    w.NostrSession = { getPlayer: () => JSON.parse(localStorage.getItem('race-player')!),
      updatePlayer: (p: any) => localStorage.setItem('race-player', JSON.stringify(p)) };
  });
  const adapter = readFileSync(resolve(root, 'js/amber-signer.js'), 'utf8')
    .replace("const tools = () => import('https://esm.sh/nostr-tools@2?bundle');", 'const tools = () => window.__gate;');
  await page.addScriptTag({ content: adapter });
  const cdp = await context.newCDPSession(page); await cdp.send('Page.enable');
  cdp.on('Page.frameRequestedNavigation', (e: any) => { if (e.url.startsWith('intent:')) outgoing.set(page, e.url); });
  for (const action of ['switch', 'cancel-retry']) {
    await page.evaluate(pk => {
      const w = window as any;
      w.NostrSession.updatePlayer({ pubkey: pk, auth_mode: 'session' });
      w.__gate = new Promise(resolve => { w.__release = () => resolve(w.__tools); });
      w.AmberSigner.login();
    }, pubkey);
    const intent = await openAmber(page);
    await page.evaluate(({ url, action, other }) => {
      const w = window as any;
      // Start restore directly so the import is guaranteed to be pending, then
      // duplicate it as startup/pageshow can do. Both callers share one result.
      history.replaceState(null, '', url);
      w.__restore = w.AmberSigner.restore(w.NostrSession.getPlayer());
      w.__duplicate = w.AmberSigner.restore(w.NostrSession.getPlayer());
      w.__shared = w.__restore === w.__duplicate;
      if (action === 'switch') w.NostrSession.updatePlayer({ pubkey: other, auth_mode: 'session' });
      else { w.AmberSigner.cancel(); w.AmberSigner.login(); }
    }, { url: amberReturn(intent, other), action, other });
    let retryId: string | undefined;
    if (action === 'cancel-retry') {
      await openAmber(page);
      retryId = await page.evaluate(() => JSON.parse(localStorage.getItem('word5-amber-pending-v1')!).id);
    }
    const result = await page.evaluate(async () => {
      const w = window as any; w.__release();
      const player = await w.__restore; w.NostrSession.updatePlayer(player);
      return { shared: w.__shared, player, pending: JSON.parse(localStorage.getItem('word5-amber-pending-v1') || 'null'), success: !!document.getElementById('amberConnected') };
    });
    check(result.shared && !result.success && (action === 'switch' ? result.player.pubkey === other && !result.player.linked_pubkey : result.player.pubkey === pubkey && result.pending?.id === retryId),
      `late login callback cannot overwrite ${action === 'switch' ? 'an account switch' : 'Cancel and a newer request'} during module loading`);
    await page.evaluate(() => (window as any).AmberSigner.cancel());
  }
  await context.close();
}
