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
        let parsed;
        try { parsed = JSON.parse(plaintext); } catch (_) { if (signer.mode === "amber") throw new Error("Decrypted record did not match the Word5 schema"); continue; }
        const valid = validate(parsed);
        if (valid) return { event, value: valid };
        if (signer.mode === "amber") throw new Error("Decrypted record did not match the Word5 schema");
      } catch (error) { if (signer.mode === "amber") throw error; /* Ignore invalid/malformed older-browser records. */ }
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
    let disposed = false, busy = false, interrupted = false;
    const assertActive = () => { if (disposed || interrupted) throw new Error("Sync identity changed; retry with the current account"); };
    const journalKey = () => `word5-amber-sync:${pubkey}`;
    let journal = null;
    function saveJournal() { assertActive(); journal.at = Date.now(); storage.setItem(journalKey(), JSON.stringify(journal)); }
    function loadJournal() {
      // Transient recovery metadata never survives an account switch. Existing
      // per-account game/settings storage and opt-in flags are untouched.
      if (typeof storage.key === "function") for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith("word5-amber-sync:") && key !== journalKey()) storage.removeItem(key);
      }
      try { journal = JSON.parse(storage.getItem(journalKey()) || "null"); } catch (_) { journal = null; }
      const dictionary = value => value && typeof value === "object" && !Array.isArray(value);
      const validWrite = ([d, value]) => (d === SETTINGS_D || /^word5:game:\d+:v1$/.test(d)) &&
        value && HEX_64.test(value.hash) && typeof value.content === "string" && value.content.length <= MAX_CIPHERTEXT &&
        (value.verified === undefined || typeof value.verified === "boolean");
      const valid = journal && journal.pubkey === pubkey && Number.isFinite(journal.at) &&
        Date.now() >= journal.at && Date.now() - journal.at < 15 * 60 * 1000 &&
        (journal.proven === undefined || typeof journal.proven === "boolean") &&
        (journal.proofCipher === undefined || typeof journal.proofCipher === "string" && journal.proofCipher.length <= MAX_CIPHERTEXT) &&
        dictionary(journal.writes) && Object.keys(journal.writes).length <= 3 && Object.entries(journal.writes).every(validWrite) &&
        dictionary(journal.published) && Object.keys(journal.published).length <= 3 && Object.values(journal.published).every(x => typeof x === "string" && HEX_64.test(x)) &&
        Array.isArray(journal.applied) && journal.applied.length <= 20 &&
        journal.applied.every(x => x && HEX_64.test(x.id) && Number.isSafeInteger(x.updatedAt) && x.updatedAt >= 0);
      if (!valid) {
        storage.removeItem(journalKey());
        journal = { pubkey, at: Date.now(), writes: {}, published: {}, applied: [] };
      }
    }
    const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
    const lastCreatedAt = new Map();
    const status = (state, message, detail = {}) => { if (!disposed) options.onStatus?.({ state, message, enabled, ...detail }); };
    const enabledKey = (key) => `word5-sync-enabled:${key}`;

    async function resolveSigner() {
      assertActive();
      signer = await options.getSigner();
      pubkey = await signer.getPublicKey();
      assertActive();
      if (signer.mode === "amber") loadJournal();
      if (!HEX_64.test(pubkey)) throw new Error("Signer returned an invalid pubkey");
      if (typeof signer.nip44Encrypt !== "function" || typeof signer.nip44Decrypt !== "function") {
        const error = new Error("This signer does not support NIP-44 encryption and decryption");
        error.code = "unsupported"; throw error;
      }
      return signer;
    }

    async function proveNip44() {
      const probe = "word5-nip44-capability-v1";
      if (signer.mode === "amber" && journal.proven) return;
      const ciphertext = signer.mode === "amber" && journal.proofCipher || await signer.nip44Encrypt(pubkey, probe);
      assertActive();
      if (signer.mode === "amber") { journal.proofCipher = ciphertext; saveJournal(); }
      if (typeof ciphertext !== "string" || await signer.nip44Decrypt(pubkey, ciphertext) !== probe) {
        if (signer.mode === "amber") { delete journal.proofCipher; saveJournal(); }
        throw new Error("This signer could not complete NIP-44 self-encryption");
      }
      assertActive();
      if (signer.mode === "amber") { journal.proven = true; delete journal.proofCipher; saveJournal(); }
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
      assertActive();
      const unseen = (events, localUpdatedAt) => signer.mode === "amber"
        ? events.filter(e => !journal.applied.some(x => x.id === e.id && localUpdatedAt >= x.updatedAt)) : events;
      let settings = await decryptLatest({ events: unseen(settingsEvents, Number(local.settingsUpdatedAt) || 0), pubkey, d: SETTINGS_D, signer,
        verifyEvent: options.verifyEvent, validate: validateSettings });
      assertActive();
      if (!settings && signer.mode === "amber") {
        const event = selectCandidates(settingsEvents, pubkey, SETTINGS_D, options.verifyEvent).find(e => journal.applied.some(x => x.id === e.id));
        const applied = event && journal.applied.find(x => x.id === event.id);
        if (applied) settings = { event, value: { updatedAt: applied.updatedAt, preferences: { hardMode: local.hardMode } } };
      }
      if (settings) lastCreatedAt.set(SETTINGS_D, settings.event.created_at);
      if (settings && settings.value.updatedAt > (Number(options.getLocalState().settingsUpdatedAt) || 0)) {
        options.applySettings(settings.value.preferences, settings.value.updatedAt);
      }
      if (signer.mode === "amber" && settings) { journal.applied = [...journal.applied.filter(x => x.id !== settings.event.id), { id: settings.event.id, updatedAt: settings.value.updatedAt }].slice(-20); saveJournal(); }
      const refreshed = options.getLocalState();
      let game = completed ? null : await decryptLatest({ events: unseen(gameEvents, Number(refreshed.gameUpdatedAt) || 0), pubkey, d: GAME_D(periodId), signer,
        verifyEvent: options.verifyEvent, validate: (value) => validateGame(value, periodId) });
      assertActive();
      if (!game && !completed && signer.mode === "amber") {
        const event = selectCandidates(gameEvents, pubkey, GAME_D(periodId), options.verifyEvent).find(e => journal.applied.some(x => x.id === e.id));
        const applied = event && journal.applied.find(x => x.id === event.id);
        if (applied) game = { event, value: { updatedAt: applied.updatedAt, state: { guesses: refreshed.guesses, hardMode: refreshed.hardMode } } };
      }
      if (game) lastCreatedAt.set(GAME_D(periodId), game.event.created_at);
      if (signer.mode === "amber" && game) {
        const nowCompleted = await options.isServerCompleted(signer, periodId);
        assertActive();
        if (nowCompleted) game = null;
      }
      if (options.getLocalState().periodId !== periodId) throw new Error("Puzzle changed during sync; local game kept");
      if (game && !options.getLocalState().gameOver && game.value.updatedAt > (Number(options.getLocalState().gameUpdatedAt) || 0)) {
        options.applyGame(game.value.state, game.value.updatedAt);
      }
      if (signer.mode === "amber" && game) { journal.applied = [...journal.applied.filter(x => x.id !== game.event.id), { id: game.event.id, updatedAt: game.value.updatedAt }].slice(-20); saveJournal(); }
      status("ready", completed ? "Sync on · completed game kept" : "Encrypted sync on");
      return { settings, game, completed };
    }

    async function publishNewerLocal(report) {
      const local = options.getLocalState();
      const remoteSettingsAt = Number(report.settings?.value?.updatedAt) || 0;
      if ((local.settingsUpdatedAt > remoteSettingsAt) || (!report.settings && local.hardMode)) {
        await publish(SETTINGS_D, makeSettings(local.hardMode, local.settingsUpdatedAt || 0));
      }
      const remoteGameAt = Number(report.game?.value?.updatedAt) || 0;
      if (!report.completed && !local.gameOver && local.guesses.length > 0 &&
          (local.gameUpdatedAt > remoteGameAt || !report.game)) {
        await publish(GAME_D(local.periodId), makeGame(local.periodId, local.guesses, local.hardMode,
          local.gameUpdatedAt || 0));
      }
    }

    async function enable() {
      if (busy) throw new Error("Finish or cancel the current sync action first");
      busy = true; interrupted = false;
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
        if (error.code === "AMBER_CANCELLED" && signer?.mode === "amber") storage.removeItem(journalKey());
        enabled = false;
        if (!interrupted) status(error.code === "unsupported" ? "unsupported" : "error", error.message || String(error));
        throw error;
      } finally { busy = false; }
    }

    async function init() {
      try {
        await resolveSigner();
        enabled = storage.getItem(enabledKey(pubkey)) === "1";
        if (signer.mode === "amber") { status("paused", enabled ? "Sync paused · tap Resume encrypted sync" : "Encrypted sync is off · enable to verify Amber encryption"); return null; }
        if (!enabled) { status("disabled", "Encrypted sync is off"); return null; }
        await proveNip44();
        const report = await restore();
        try { await publishNewerLocal(report); }
        catch (error) { status("error", `Local game kept · ${error.message || error}`); }
        return report;
      } catch (error) {
        if (error.code === "AMBER_CANCELLED" && signer?.mode === "amber") storage.removeItem(journalKey());
        enabled = false;
        if (!interrupted) status(error.code === "unsupported" ? "unsupported" : "error", error.message || String(error));
        return null;
      }
    }

    function disable() {
      interrupted = true; enabled = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); queued.clear();
      if (pubkey) { storage.removeItem(enabledKey(pubkey)); storage.removeItem(journalKey()); }
      if (signer?.mode === "amber") options.cancelSigner?.();
      status("disabled", "Encrypted sync is off");
    }

    async function publish(d, value) {
      if (!enabled) return null;
      if (!signer) await resolveSigner();
      const plaintext = JSON.stringify(value);
      if (containsPrivateMaterial(value)) throw new Error("Refusing to sync private material");
      const inputHash = signer.mode === "amber" ? await hash(plaintext) : null;
      assertActive();
      if (signer.mode === "amber" && journal.published?.[d] === inputHash) return null;
      let saved = signer.mode === "amber" ? journal.writes[d] : null;
      if (saved && saved.hash !== inputHash) {
        delete journal.writes[d]; saveJournal();
        throw new Error("Local state changed during approval. Cancel any pending Amber request and retry Save encrypted state");
      }
      const content = saved?.content || await signer.nip44Encrypt(pubkey, plaintext);
      assertActive();
      if (signer.mode === "amber") {
        if (!saved) { saved = { hash: inputHash, content }; journal.writes[d] = saved; saveJournal(); }
        if (!saved.verified) {
          if (await signer.nip44Decrypt(pubkey, content) !== plaintext) { delete journal.writes[d]; saveJournal(); throw new Error("Amber encryption roundtrip did not match local state; nothing published"); }
          assertActive(); saved.verified = true; saveJournal();
        }
      }
      const createdAt = Math.max(Math.floor(Date.now() / 1000), (lastCreatedAt.get(d) || 0) + 1);
      const event = await signer.signEvent({ kind: KIND, created_at: createdAt,
        tags: [["d", d], ["schema", ENVELOPE_SCHEMA]], content });
      assertActive();
      lastCreatedAt.set(d, createdAt);
      const result = await options.publishEvent(event);
      assertActive();
      const accepted = result.filter((item) => item.ok).length;
      if (!accepted) throw new Error("No storage relay confirmed the encrypted record");
      if (signer.mode === "amber") { delete journal.writes[d]; journal.published ||= {}; journal.published[d] = inputHash; saveJournal(); }
      status(accepted === result.length ? "ready" : "partial",
        accepted === result.length ? "Encrypted sync saved" : `Saved to ${accepted}/${result.length} storage relays`,
        { relayResults: result });
      return { event, result };
    }

    function queuePublish(d, value) {
      if (!enabled) return;
      queued.set(d, value);
      if (signer?.mode === "amber") { status("paused", "Local changes kept · tap Save encrypted state"); return; }
      clearTimeout(timers.get(d));
      timers.set(d, setTimeout(async () => {
        const next = queued.get(d); queued.delete(d); timers.delete(d);
        try { if (next) await publish(d, next); }
        catch (error) { status("error", `Local game kept · ${error.message || error}`); }
      }, options.debounceMs ?? 750));
    }

    return {
      init, enable, disable, restore,
      async saveLocal() {
        if (busy) throw new Error("Finish or cancel the current sync action first");
        busy = true; interrupted = false;
        try {
          await resolveSigner();
          if (!enabled) throw new Error("Enable encrypted sync first");
          await proveNip44();
          const local = options.getLocalState();
          await publish(SETTINGS_D, makeSettings(local.hardMode, local.settingsUpdatedAt || 0));
          if (!local.gameOver && local.guesses.length) await publish(GAME_D(local.periodId), makeGame(local.periodId, local.guesses, local.hardMode, local.gameUpdatedAt || 0));
          if (JSON.stringify(options.getLocalState()) !== JSON.stringify(local)) status("paused", "Newer local changes kept · tap Save encrypted state");
          else queued.clear();
        } catch (error) { if (error.code === "AMBER_CANCELLED" && signer?.mode === "amber") storage.removeItem(journalKey()); status("error", error.message || String(error)); throw error; }
        finally { busy = false; }
      },
      dispose() { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); queued.clear(); },
      isEnabled: () => enabled,
      checkpointSettings(hardMode, updatedAt) { queuePublish(SETTINGS_D, makeSettings(hardMode, updatedAt)); },
      checkpointGame(periodId, guesses, hardMode, updatedAt, gameOver = false) {
        if (!gameOver) queuePublish(GAME_D(periodId), makeGame(periodId, guesses, hardMode, updatedAt));
      },
      flush: async () => {
        if (signer?.mode === "amber") throw new Error("Tap Save encrypted state to approve Amber sync");
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
