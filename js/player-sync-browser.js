(function () {
  async function create(callbacks) {
    if (!window.Word5PlayerSyncCore) throw new Error("Word5 sync core unavailable");
    const { SimplePool, verifyEvent } = await import("https://esm.sh/nostr-tools@2?bundle");
    const relays = () => [...new Set((window.NostrPost?.STORAGE_RELAYS || window.NostrPost?.DEFAULT_RELAYS || [
      "wss://relay.damus.io", "wss://nos.lol", "wss://relay.snort.social",
    ]).filter((relay) => /^wss:\/\//.test(relay)))];

    async function fetchEvents(filter) {
      const pool = new SimplePool();
      const targets = relays();
      try { return await pool.querySync(targets, filter, { maxWait: 12_000 }); }
      finally { try { pool.close(targets); } catch (_) {} }
    }

    async function publishEvent(event) {
      const pool = new SimplePool();
      const targets = relays();
      try {
        const settled = await Promise.allSettled(pool.publish(targets, event));
        return targets.map((relay, index) => ({ relay, ok: settled[index]?.status === "fulfilled",
          error: settled[index]?.status === "rejected" ? String(settled[index].reason || "relay rejected event") : null }));
      } finally { try { pool.close(targets); } catch (_) {} }
    }

    async function isServerCompleted(signer, periodId) {
      if (signer.mode === "amber") {
        const pubkey = await signer.getPublicKey();
        const response = await fetch(`api/player-history?pubkey=${encodeURIComponent(pubkey)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok || payload.pubkey !== pubkey || payload.periodId !== periodId || typeof payload.completed !== "boolean") throw new Error("Fresh completion status unavailable; local game kept");
        return payload.completed;
      }
      const event = await signer.signEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000),
        tags: [["schema", "word5.sync-status.v1"]], content: JSON.stringify({ periodId }) });
      const response = await fetch("api/completion/status", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ event }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || payload.periodId !== periodId) throw new Error(payload.error || "Completion status unavailable");
      return Boolean(payload.completed);
    }

    return window.Word5PlayerSyncCore.createController({
      ...callbacks, cancelSigner: () => window.AmberSigner?.cancel(), storage: localStorage, verifyEvent, fetchEvents, publishEvent, isServerCompleted,
      getSigner: async () => {
        await window.NostrSigners?.ready?.();
        if (!window.NostrSigners) throw new Error("Nostr signer unavailable");
        return window.NostrSigners.getActiveSigner();
      },
    });
  }

  window.Word5PlayerSyncBrowser = { create };
})();
