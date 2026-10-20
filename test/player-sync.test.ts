import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event } from "nostr-tools";

const core = require("../js/player-sync.js") as any;

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key) };
}

function selfSigner(secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, pubkey);
  return { pubkey, signer: { getPublicKey: async () => pubkey,
    signEvent: async (event: any) => finalizeEvent(event, secret),
    nip44Encrypt: async (_pubkey: string, plaintext: string) => nip44.v2.encrypt(plaintext, key),
    nip44Decrypt: async (_pubkey: string, ciphertext: string) => nip44.v2.decrypt(ciphertext, key) } };
}

function harness(identity = selfSigner()) {
  const events: Event[] = [], statuses: any[] = [];
  const storage = memoryStorage();
  let local: any = { periodId: 123, guesses: [], gameOver: false, hardMode: false, settingsUpdatedAt: 0, gameUpdatedAt: 0 };
  let completed = false;
  const options = {
    storage, getSigner: async () => identity.signer, verifyEvent,
    fetchEvents: async (filter: any) => events.filter((event) => event.pubkey === filter.authors[0] &&
      event.tags.some((tag) => tag[0] === "d" && filter["#d"].includes(tag[1]))),
    publishEvent: async (event: Event) => { events.push(event); return [{ relay: "wss://one.test", ok: true }, { relay: "wss://two.test", ok: true }]; },
    isServerCompleted: async () => completed,
    getLocalState: () => ({ ...local, guesses: [...local.guesses] }),
    applySettings: (preferences: any, updatedAt: number) => { local.hardMode = preferences.hardMode; local.settingsUpdatedAt = updatedAt; },
    applyGame: (state: any, updatedAt: number) => { local.guesses = [...state.guesses]; local.hardMode = state.hardMode; local.gameUpdatedAt = updatedAt; },
    onStatus: (status: any) => statuses.push(status), debounceMs: 0,
  };
  return { identity, events, statuses, storage, options, get local() { return local; }, set local(value) { local = value; },
    setCompleted(value: boolean) { completed = value; } };
}

describe("encrypted NIP-78 player sync", () => {
  test("opt-in self-encrypts settings and unfinished progress, then restores for the same npub", async () => {
    const h = harness();
    const first = core.createController(h.options);
    await first.enable();
    first.checkpointSettings(true, 100);
    first.checkpointGame(123, ["APPLE", "BRAVE"], true, 101, false);
    await first.flush();
    expect(h.events).toHaveLength(2);
    expect(h.events.map((event) => event.kind)).toEqual([30078, 30078]);
    expect(h.events.map((event) => event.tags.find((tag) => tag[0] === "d")?.[1]).sort()).toEqual([
      "word5:game:123:v1", "word5:settings:v1",
    ]);
    for (const event of h.events) {
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(h.identity.pubkey);
      expect(event.content).not.toContain("APPLE");
      expect(JSON.stringify(event)).not.toMatch(/nsec1|privkey|targetWord|solution/i);
    }
    h.local = { periodId: 123, guesses: [], gameOver: false, hardMode: false, settingsUpdatedAt: 0, gameUpdatedAt: 0 };
    const second = core.createController(h.options);
    await second.enable();
    expect(h.local).toMatchObject({ guesses: ["APPLE", "BRAVE"], hardMode: true, settingsUpdatedAt: 100, gameUpdatedAt: 101 });
  });

  test("disable is local and unsupported NIP-44 fails safely without publishing", async () => {
    const h = harness();
    const controller = core.createController(h.options);
    await controller.enable();
    controller.disable();
    controller.checkpointGame(123, ["APPLE"], false, 10, false);
    await controller.flush();
    expect(h.events).toHaveLength(0);
    expect(h.statuses.at(-1)).toMatchObject({ state: "disabled", enabled: false });
    const unsupported = core.createController({ ...h.options, getSigner: async () => ({
      getPublicKey: async () => h.identity.pubkey, signEvent: h.identity.signer.signEvent,
    }) });
    await expect(unsupported.enable()).rejects.toThrow("does not support NIP-44");
    const rejecting = core.createController({ ...h.options, getSigner: async () => ({ ...h.identity.signer,
      nip44Encrypt: async () => { throw new Error("remote signer rejected nip44_encrypt"); },
    }) });
    await expect(rejecting.enable()).rejects.toThrow("rejected nip44_encrypt");
    expect(h.events).toHaveLength(0);
  });

  test("rejects malformed, wrong-author, wrong-period and stale records; server completion wins", async () => {
    const h = harness();
    const encrypt = h.identity.signer.nip44Encrypt;
    const make = async (secret: Uint8Array, d: string, value: unknown, created_at: number) => finalizeEvent({ kind: 30078, created_at,
      tags: [["d", d], ["schema", "word5.encrypted-state.v1"]], content: await encrypt(h.identity.pubkey, JSON.stringify(value)) }, secret);
    h.events.push(await make(generateSecretKey(), "word5:game:123:v1", core.makeGame(123, ["APPLE"], false, 900), 9));
    h.events.push(await make(generateSecretKey(), "word5:game:wrong:v1", core.makeGame(123, ["APPLE"], false, 901), 10));
    h.events.push(await h.identity.signer.signEvent({ kind: 30078, created_at: 11,
      tags: [["d", "word5:game:123:v1"], ["schema", "word5.encrypted-state.v1"]],
      content: await encrypt(h.identity.pubkey, JSON.stringify({ broken: true })) }));
    // Use the real identity signer for records that pass author/signature checks.
    h.events.push(await h.identity.signer.signEvent({ kind: 30078, created_at: 12,
      tags: [["d", "word5:game:123:v1"], ["schema", "word5.encrypted-state.v1"]],
      content: await encrypt(h.identity.pubkey, JSON.stringify(core.makeGame(999, ["APPLE"], false, 902))) }));
    h.events.push(await h.identity.signer.signEvent({ kind: 30078, created_at: 13,
      tags: [["d", "word5:game:123:v1"], ["schema", "word5.encrypted-state.v1"]],
      content: await encrypt(h.identity.pubkey, JSON.stringify(core.makeGame(123, ["BRAVE"], true, 400))) }));
    h.local = { periodId: 123, guesses: ["APPLE"], gameOver: false, hardMode: false, settingsUpdatedAt: 0, gameUpdatedAt: 500 };
    await core.createController(h.options).enable();
    expect(h.local.guesses).toEqual(["APPLE"]);
    h.local.gameUpdatedAt = 0;
    h.setCompleted(true);
    await core.createController(h.options).enable();
    expect(h.local.guesses).toEqual(["APPLE"]);
  });

  test("strict payloads exclude answers, private keys and completed games", async () => {
    expect(core.validateGame({ schema: "word5.game.v1", periodId: 1, updatedAt: 1,
      state: { guesses: [], hardMode: false, targetWord: "APPLE" } }, 1)).toBeNull();
    expect(core.containsPrivateMaterial({ nsec: "nsec1secret" })).toBe(true);
    const h = harness();
    const controller = core.createController(h.options);
    await controller.enable();
    controller.checkpointGame(123, ["APPLE"], false, 10, true);
    await controller.flush();
    expect(h.events).toHaveLength(0);
  });
});
