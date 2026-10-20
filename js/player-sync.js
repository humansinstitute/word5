// Opt-in encrypted NIP-78 sync for Word5 preferences and unfinished games.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.Word5PlayerSyncCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const KIND = 30078;
  const ENVELOPE_SCHEMA = "word5.encrypted-state.v1";
  const SETTINGS_D = "word5:settings:v1";
  const GAME_D = (periodId) => `word5:game:${periodId}:v1`;
  const MAX_CIPHERTEXT = 64 * 1024;
  const HEX_64 = /^[0-9a-f]{64}$/;

  function exactKeys(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  }

  function validateSettings(value) {
    if (!exactKeys(value, ["schema", "updatedAt", "preferences"]) || value.schema !== "word5.settings.v1" ||
        !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
        !exactKeys(value.preferences, ["hardMode"]) || typeof value.preferences.hardMode !== "boolean") return null;
    return value;
  }

  function validateGame(value, expectedPeriodId) {
    if (!exactKeys(value, ["schema", "periodId", "updatedAt", "state"]) || value.schema !== "word5.game.v1" ||
        value.periodId !== expectedPeriodId || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 ||
        !exactKeys(value.state, ["guesses", "hardMode"]) || typeof value.state.hardMode !== "boolean" ||
        !Array.isArray(value.state.guesses) || value.state.guesses.length > 5 ||
        value.state.guesses.some((guess) => typeof guess !== "string" || !/^[A-Z]{5}$/.test(guess))) return null;
    return value;
  }

  function tag(event, name) {
    return event?.tags?.find((candidate) => candidate[0] === name)?.[1] || "";
  }

  function selectCandidates(events, pubkey, d, verifyEvent) {
    return (Array.isArray(events) ? events : []).filter((event) => event && event.kind === KIND &&
      event.pubkey === pubkey && tag(event, "d") === d && tag(event, "schema") === ENVELOPE_SCHEMA &&
      typeof event.content === "string" && event.content.length <= MAX_CIPHERTEXT && verifyEvent(event))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  }

  async function decryptLatest({ events, pubkey, d, signer, verifyEvent, validate }) {
    for (const event of selectCandidates(events, pubkey, d, verifyEvent)) {
      try {
        const plaintext = await signer.nip44Decrypt(pubkey, event.content);
        const parsed = JSON.parse(plaintext);
        const valid = validate(parsed);
        if (valid) return { event, value: valid };
      } catch (_) { /* Ignore invalid/malformed older-browser records. */ }
    }
    return null;
  }

  function containsPrivateMaterial(value) {
    const text = JSON.stringify(value).toLowerCase();
    return /nsec1|"(?:nsec|privkey|privatekey|private_key|targetword|target_word|solution|answer)"\s*:/.test(text);
  }

  function makeSettings(hardMode, updatedAt = Date.now()) {
    const value = { schema: "word5.settings.v1", updatedAt, preferences: { hardMode: Boolean(hardMode) } };
    if (containsPrivateMaterial(value)) throw new Error("Unsafe settings payload");
    return value;
  }

  function makeGame(periodId, guesses, hardMode, updatedAt = Date.now()) {
    const value = { schema: "word5.game.v1", periodId, updatedAt,
      state: { guesses: guesses.map((guess) => String(guess).toUpperCase()), hardMode: Boolean(hardMode) } };
    if (!validateGame(value, periodId) || containsPrivateMaterial(value)) throw new Error("Unsafe game sync payload");
    return value;
  }

  function createController(options) {
    const storage = options.storage;
    let pubkey = "", signer = null, enabled = false;
    const timers = new Map(), queued = new Map();
    const lastCreatedAt = new Map();
    const status = (state, message, detail = {}) => options.onStatus?.({ state, message, enabled, ...detail });
    const enabledKey = (key) => `word5-sync-enabled:${key}`;

    async function resolveSigner() {
      signer = await options.getSigner();
      pubkey = await signer.getPublicKey();
      if (!HEX_64.test(pubkey)) throw new Error("Signer returned an invalid pubkey");
      if (typeof signer.nip44Encrypt !== "function" || typeof signer.nip44Decrypt !== "function") {
        throw new Error("This signer does not support NIP-44 encryption and decryption");
      }
      return signer;
    }

    async function proveNip44() {
      const probe = "word5-nip44-capability-v1";
      const ciphertext = await signer.nip44Encrypt(pubkey, probe);
      if (typeof ciphertext !== "string" || await signer.nip44Decrypt(pubkey, ciphertext) !== probe) {
        throw new Error("This signer could not complete NIP-44 self-encryption");
      }
    }

    async function fetchRecords(d) {
      return options.fetchEvents({ kinds: [KIND], authors: [pubkey], "#d": [d], limit: 10 });
    }

    async function restore() {
      status("syncing", "Restoring encrypted Word5 state…");
      const local = options.getLocalState();
      const periodId = local.periodId;
      const [settingsEvents, gameEvents, completed] = await Promise.all([
        fetchRecords(SETTINGS_D), fetchRecords(GAME_D(periodId)), options.isServerCompleted(signer, periodId),
      ]);
      const settings = await decryptLatest({ events: settingsEvents, pubkey, d: SETTINGS_D, signer,
        verifyEvent: options.verifyEvent, validate: validateSettings });
      if (settings) lastCreatedAt.set(SETTINGS_D, settings.event.created_at);
      if (settings && settings.value.updatedAt > (Number(local.settingsUpdatedAt) || 0)) {
        options.applySettings(settings.value.preferences, settings.value.updatedAt);
      }
      const refreshed = options.getLocalState();
      const game = completed ? null : await decryptLatest({ events: gameEvents, pubkey, d: GAME_D(periodId), signer,
        verifyEvent: options.verifyEvent, validate: (value) => validateGame(value, periodId) });
      if (game) lastCreatedAt.set(GAME_D(periodId), game.event.created_at);
      if (game && !refreshed.gameOver && game.value.updatedAt > (Number(refreshed.gameUpdatedAt) || 0)) {
        options.applyGame(game.value.state, game.value.updatedAt);
      }
      status("ready", completed ? "Sync on · completed game kept" : "Encrypted sync on");
      return { settings, game, completed };
    }

    async function publishNewerLocal(report) {
      const local = options.getLocalState();
      const remoteSettingsAt = Number(report.settings?.value?.updatedAt) || 0;
      if ((local.settingsUpdatedAt > remoteSettingsAt) || (!report.settings && local.hardMode)) {
        await publish(SETTINGS_D, makeSettings(local.hardMode, local.settingsUpdatedAt || Date.now()));
      }
      const remoteGameAt = Number(report.game?.value?.updatedAt) || 0;
      if (!report.completed && !local.gameOver && local.guesses.length > 0 &&
          (local.gameUpdatedAt > remoteGameAt || !report.game)) {
        await publish(GAME_D(local.periodId), makeGame(local.periodId, local.guesses, local.hardMode,
          local.gameUpdatedAt || Date.now()));
      }
    }

    async function enable() {
      try {
        await resolveSigner();
        await proveNip44();
        enabled = true;
        storage.setItem(enabledKey(pubkey), "1");
        const report = await restore();
        try { await publishNewerLocal(report); }
        catch (error) { status("error", `Local game kept · ${error.message || error}`); }
        return report;
      } catch (error) {
        enabled = false;
        status("unsupported", error.message || String(error));
        throw error;
      }
    }

    async function init() {
      try {
        await resolveSigner();
        enabled = storage.getItem(enabledKey(pubkey)) === "1";
        if (!enabled) { status("disabled", "Encrypted sync is off"); return null; }
        await proveNip44();
        const report = await restore();
        try { await publishNewerLocal(report); }
        catch (error) { status("error", `Local game kept · ${error.message || error}`); }
        return report;
      } catch (error) {
        enabled = false;
        status("unsupported", error.message || String(error));
        return null;
      }
    }

    function disable() {
      enabled = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); queued.clear();
      if (pubkey) storage.removeItem(enabledKey(pubkey));
      status("disabled", "Encrypted sync is off");
    }

    async function publish(d, value) {
      if (!enabled) return null;
      if (!signer) await resolveSigner();
      const plaintext = JSON.stringify(value);
      if (containsPrivateMaterial(value)) throw new Error("Refusing to sync private material");
      const content = await signer.nip44Encrypt(pubkey, plaintext);
      const createdAt = Math.max(Math.floor(Date.now() / 1000), (lastCreatedAt.get(d) || 0) + 1);
      const event = await signer.signEvent({ kind: KIND, created_at: createdAt,
        tags: [["d", d], ["schema", ENVELOPE_SCHEMA]], content });
      lastCreatedAt.set(d, createdAt);
      const result = await options.publishEvent(event);
      const accepted = result.filter((item) => item.ok).length;
      if (!accepted) throw new Error("No storage relay confirmed the encrypted record");
      status(accepted === result.length ? "ready" : "partial",
        accepted === result.length ? "Encrypted sync saved" : `Saved to ${accepted}/${result.length} storage relays`,
        { relayResults: result });
      return { event, result };
    }

    function queuePublish(d, value) {
      if (!enabled) return;
      queued.set(d, value);
      clearTimeout(timers.get(d));
      timers.set(d, setTimeout(async () => {
        const next = queued.get(d); queued.delete(d); timers.delete(d);
        try { if (next) await publish(d, next); }
        catch (error) { status("error", `Local game kept · ${error.message || error}`); }
      }, options.debounceMs ?? 750));
    }

    return {
      init, enable, disable, restore,
      dispose() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); queued.clear(); },
      isEnabled: () => enabled,
      checkpointSettings(hardMode, updatedAt) { queuePublish(SETTINGS_D, makeSettings(hardMode, updatedAt)); },
      checkpointGame(periodId, guesses, hardMode, updatedAt, gameOver = false) {
        if (!gameOver) queuePublish(GAME_D(periodId), makeGame(periodId, guesses, hardMode, updatedAt));
      },
      flush: async () => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        const pending = [...queued.entries()]; queued.clear();
        return Promise.all(pending.map(([d, value]) => publish(d, value)));
      },
    };
  }

  return { KIND, ENVELOPE_SCHEMA, SETTINGS_D, GAME_D, validateSettings, validateGame,
    selectCandidates, decryptLatest, containsPrivateMaterial, makeSettings, makeGame, createController };
});
