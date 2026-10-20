// Optional real-browser smoke for the browser-targeted NIP-78 sync controller.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent } from "nostr-tools";

const { chromium } = await import(process.env.WORD5_PLAYWRIGHT_MODULE || "playwright");
const root = resolve(import.meta.dir, "..");
const syncScript = readFileSync(resolve(root, "js/player-sync.js"), "utf8");
const secret = generateSecretKey(), pubkey = getPublicKey(secret);
const conversationKey = nip44.v2.utils.getConversationKey(secret, pubkey);
const server = Bun.serve({ port: 0, fetch(req) {
  return new URL(req.url).pathname === "/player-sync.js"
    ? new Response(syncScript, { headers: { "content-type": "text/javascript" } })
    : new Response("<!doctype html><script src='/player-sync.js'></script>", { headers: { "content-type": "text/html" } });
} });
const browser = await chromium.launch({ headless: true,
  ...(process.env.WORD5_BROWSER_EXECUTABLE ? { executablePath: process.env.WORD5_BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage();
  await page.exposeFunction("syncGetPublicKey", async () => pubkey);
  await page.exposeFunction("syncSign", async (event) => JSON.parse(JSON.stringify(finalizeEvent(event as any, secret))));
  await page.exposeFunction("syncEncrypt", async (plaintext: string) => nip44.v2.encrypt(plaintext, conversationKey));
  await page.exposeFunction("syncDecrypt", async (ciphertext: string) => nip44.v2.decrypt(ciphertext, conversationKey));
  await page.exposeFunction("syncVerify", async (event) => verifyEvent(event as any));
  await page.goto(String(server.url));
  const result = await page.evaluate(async () => {
    const core = (window as any).Word5PlayerSyncCore;
    const values = new Map(), events: any[] = [], statuses: any[] = [];
    let local: any = { periodId: 42, guesses: [], gameOver: false, hardMode: false, settingsUpdatedAt: 0, gameUpdatedAt: 0 };
    const signer = { getPublicKey: (window as any).syncGetPublicKey, signEvent: (window as any).syncSign,
      nip44Encrypt: (_pubkey: string, plaintext: string) => (window as any).syncEncrypt(plaintext),
      nip44Decrypt: (_pubkey: string, ciphertext: string) => (window as any).syncDecrypt(ciphertext) };
    const options = { storage: { getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
      getSigner: async () => signer, verifyEvent: (event: any) => (window as any).syncVerify(event),
      fetchEvents: async (filter: any) => events.filter((event) => event.pubkey === filter.authors[0] &&
        event.tags.some((tag: string[]) => tag[0] === "d" && filter["#d"].includes(tag[1]))),
      publishEvent: async (event: any) => { events.push(event); return [{ relay: "wss://one.test", ok: true }]; },
      isServerCompleted: async () => false, getLocalState: () => ({ ...local, guesses: [...local.guesses] }),
      applySettings: (settings: any, updatedAt: number) => { local.hardMode = settings.hardMode; local.settingsUpdatedAt = updatedAt; },
      applyGame: (state: any, updatedAt: number) => { local = { ...local, ...state, gameUpdatedAt: updatedAt }; },
      onStatus: (status: any) => statuses.push(status), debounceMs: 0 };
    const first = core.createController(options);
    await first.enable(); first.checkpointSettings(true, 100); first.checkpointGame(42, ["APPLE"], true, 101); await first.flush();
    const encrypted = events.every((event) => !event.content.includes("APPLE") && !JSON.stringify(event).match(/nsec1|targetWord|solution/i));
    local = { periodId: 42, guesses: [], gameOver: false, hardMode: false, settingsUpdatedAt: 0, gameUpdatedAt: 0 };
    await core.createController(options).enable();
    const restored = local.hardMode && local.guesses.join(",") === "APPLE" && local.gameUpdatedAt === 101;
    first.disable(); first.checkpointGame(42, ["BRAVE"], true, 102); await first.flush();
    let unsupported = false;
    try { await core.createController({ ...options, getSigner: async () => ({ getPublicKey: signer.getPublicKey, signEvent: signer.signEvent }) }).enable(); }
    catch (_) { unsupported = true; }
    return { encrypted, restored, unsupported, eventCount: events.length, lastStatus: statuses.at(-1)?.state };
  });
  if (!result.encrypted || !result.restored || !result.unsupported || result.eventCount !== 2) {
    throw new Error(`Browser player sync failed: ${JSON.stringify(result)}`);
  }
  console.log("Browser encrypted NIP-78 enable → checkpoint → same-npub restore → disable/unsupported passed");
} finally {
  await browser.close();
  server.stop(true);
}
