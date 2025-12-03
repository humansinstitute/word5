// Nostr session manager: localStorage-backed ephemeral key with optional NIP-07 link.
(function () {
  const STORAGE_KEY = "spiders.nostr.player.v1";
  let readyResolve;
  const whenReady = new Promise((resolve) => (readyResolve = resolve));

  const toHex = (bytes) =>
    Array.from(bytes || []).map((b) => b.toString(16).padStart(2, "0")).join("");

  const save = (player) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(player));
    } catch (_) {}
  };

  const load = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return null;
  };

  const isValid = (p) => Boolean(p && p.privkey && p.pubkey && p.npub && p.nsec);

  async function generateSessionPlayer() {
    const { generateSecretKey, getPublicKey, nip19 } = await import(
      "https://esm.sh/nostr-tools@2?bundle"
    );
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    return {
      auth_mode: "session",
      privkey: toHex(sk),
      pubkey: pk,
      npub: nip19.npubEncode(pk),
      nsec: nip19.nsecEncode(sk),
      created_at: Date.now(),
    };
  }

  async function ensurePlayer() {
    let player = load();
    if (!isValid(player)) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (_) {}
      player = await generateSessionPlayer();
      save(player);
    }
    notifyReady(player);
    return player;
  }

  function notifyReady(player) {
    try {
      readyResolve && readyResolve(player);
      const evt = new CustomEvent("player-ready", { detail: { player } });
      window.dispatchEvent(evt);
    } catch (_) {}
  }

  const getPlayer = () => load();

  function updatePlayer(patch) {
    const current = load() || {};
    const updated = { ...current, ...patch };
    save(updated);
    notifyReady(updated);
    return updated;
  }

  async function resetPlayer() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    const fresh = await generateSessionPlayer();
    save(fresh);
    notifyReady(fresh);
    return fresh;
  }

  async function importNsec(nsec) {
    if (!nsec) throw new Error("Missing nsec");
    const { nip19, getPublicKey } = await import(
      "https://esm.sh/nostr-tools@2?bundle"
    );
    const decoded = nip19.decode(nsec);
    if (decoded.type !== "nsec") throw new Error("Not an nsec");
    const sk = decoded.data;
    const pk = getPublicKey(sk);
    const player = {
      auth_mode: "session",
      privkey: toHex(sk),
      pubkey: pk,
      npub: nip19.npubEncode(pk),
      nsec,
      imported_at: Date.now(),
    };
    save(player);
    notifyReady(player);
    return player;
  }

  const exportNsec = () => {
    const p = load();
    if (!p || p.auth_mode !== "session") return null;
    return p.nsec || null;
  };

  async function loginWithNip07() {
    if (!window.nostr || typeof window.nostr.getPublicKey !== "function") {
      throw new Error("NIP-07 extension not available");
    }
    const pubkey = await window.nostr.getPublicKey();
    const { nip19 } = await import("https://esm.sh/nostr-tools@2?bundle");
    const npub = nip19.npubEncode(pubkey);
    return updatePlayer({
      auth_mode: "nip07",
      linked_pubkey: pubkey,
      linked_npub: npub,
      linked_at: Date.now(),
    });
  }

  function unlinkNip07() {
    const p = load() || {};
    const cleaned = { ...p };
    delete cleaned.linked_pubkey;
    delete cleaned.linked_npub;
    delete cleaned.linked_at;
    cleaned.auth_mode = "session";
    save(cleaned);
    notifyReady(cleaned);
    return cleaned;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => ensurePlayer());
  } else {
    ensurePlayer();
  }

  window.NostrSession = {
    ensurePlayer,
    getPlayer,
    updatePlayer,
    resetPlayer,
    importNsec,
    exportNsec,
    loginWithNip07,
    unlinkNip07,
    whenReady,
  };
})();
