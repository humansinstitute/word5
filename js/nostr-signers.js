// Signer resolution: prefer explicit linked signers, otherwise session key.
(function () {
  const { whenReady, getPlayer } = window.NostrSession || {};
  let memoryBunkerSigner = null;
  let memoryBunkerUri = null;

  // NIP-46 identifies a client by the pubkey of its client keypair. The remote signer authorises
  // that pubkey once, when the bunker:// URI is redeemed, and remembers it. Generating a fresh
  // keypair on every page load therefore makes the game a *different* client each time: the first
  // load works, and every load afterwards is rejected by the signer with "Unknown client", because
  // the URI's secret has already been redeemed and cannot authorise a second key.
  //
  // So persist the client key next to the URI it was authorised for. It is keyed BY that URI, so
  // pasting a different bunker:// URI still starts a fresh client identity.
  //
  // On storage: this is the ephemeral NIP-46 client key, not the user's identity key - it signs
  // nothing but RPC envelopes to the signer. WORD5 already keeps the session identity's own
  // privkey/nsec in localStorage, so this adds no new class of exposure.
  const CLIENT_KEY_STORAGE = "word5.nostr.bunker-client.v1";

  function bytesToHex(bytes) {
    return Array.from(bytes || [])
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function loadClientSecret(bunkerUri) {
    try {
      const raw = localStorage.getItem(CLIENT_KEY_STORAGE);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      // Only reuse a key that was authorised for THIS URI, and only if it is a well-formed
      // 32-byte secret - anything else and we fall back to generating a new one.
      if (!saved || saved.uri !== bunkerUri || typeof saved.sk !== "string") return null;
      if (!/^[0-9a-f]{64}$/i.test(saved.sk)) return null;
      return hexToBytes(saved.sk);
    } catch (_) {
      return null;
    }
  }

  function saveClientSecret(bunkerUri, clientSecret) {
    try {
      localStorage.setItem(
        CLIENT_KEY_STORAGE,
        JSON.stringify({ uri: bunkerUri, sk: bytesToHex(clientSecret) }),
      );
    } catch (_) {}
  }

  function clearClientSecret() {
    try {
      localStorage.removeItem(CLIENT_KEY_STORAGE);
    } catch (_) {}
  }

  function hexToBytes(hex) {
    if (!hex) return new Uint8Array();
    const out = [];
    for (let i = 0; i < hex.length; i += 2) {
      out.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return new Uint8Array(out);
  }

  async function getNip19() {
    const { nip19 } = await import("https://esm.sh/nostr-tools@2?bundle");
    return nip19;
  }

  async function connectBunker(bunkerUri, options = {}) {
    const { forceNew = false } = options;
    if (!bunkerUri) throw new Error("Missing bunker URI");

    if (memoryBunkerSigner && memoryBunkerUri === bunkerUri && !forceNew) {
      return memoryBunkerSigner;
    }

    if (memoryBunkerSigner && typeof memoryBunkerSigner.close === "function") {
      try {
        await memoryBunkerSigner.close();
      } catch (_) {}
    }
    memoryBunkerSigner = null;
    memoryBunkerUri = null;

    const [pure, nip46] = await Promise.all([
      import("https://esm.sh/nostr-tools@2.10.0/pure?bundle"),
      import("https://esm.sh/nostr-tools@2.10.0/nip46?bundle"),
    ]);
    const pointer = await nip46.parseBunkerInput(bunkerUri);
    if (!pointer) throw new Error("Unable to parse bunker details");

    const clientSecret = loadClientSecret(bunkerUri) || pure.generateSecretKey();
    const signer = new nip46.BunkerSigner(clientSecret, pointer);
    await signer.connect();
    await signer.getPublicKey();

    // Persist only after the signer has accepted this key, so a failed handshake never pins a
    // client identity the remote signer does not know about.
    saveClientSecret(bunkerUri, clientSecret);

    memoryBunkerSigner = signer;
    memoryBunkerUri = bunkerUri;
    return signer;
  }

  async function disconnectBunker() {
    if (memoryBunkerSigner && typeof memoryBunkerSigner.close === "function") {
      try {
        await memoryBunkerSigner.close();
      } catch (_) {}
    }
    memoryBunkerSigner = null;
    memoryBunkerUri = null;
    // Forgetting the bunker means forgetting the client identity it authorised; a later
    // reconnect should present itself as a new client.
    clearClientSecret();
  }

  async function getActiveSigner() {
    if (!window.NostrSession) throw new Error("NostrSession unavailable");
    const player = getPlayer ? getPlayer() : null;
    if (
      player?.auth_mode === "nip07" &&
      window.nostr &&
      typeof window.nostr.signEvent === "function"
    ) {
      return {
        getPublicKey: () => window.nostr.getPublicKey(),
        signEvent: (evt) => window.nostr.signEvent(evt),
        mode: "nip07",
      };
    }
    if (player?.auth_mode === "bunker" && player?.bunker_uri) {
      const signer = await connectBunker(player.bunker_uri);
      return {
        getPublicKey: () => signer.getPublicKey(),
        signEvent: (evt) => signer.signEvent(evt),
        mode: "bunker",
      };
    }
    if (player?.privkey) {
      const { finalizeEvent } = await import(
        "https://esm.sh/nostr-tools@2?bundle"
      );
      const sk = hexToBytes(player.privkey);
      return {
        getPublicKey: async () => player.pubkey,
        signEvent: async (evt) => finalizeEvent(evt, sk),
        mode: "session",
      };
    }
    throw new Error("No signer available");
  }

  const getDisplayNpub = () => {
    const p = getPlayer ? getPlayer() : null;
    return p?.linked_npub || p?.npub || null;
  };

  async function connectBunkerAndReturnIdentity(bunkerUri) {
    const signer = await connectBunker(bunkerUri, { forceNew: true });
    const pubkey = await signer.getPublicKey();
    const nip19 = await getNip19();
    return {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      signer,
    };
  }

  async function ready() {
    if (whenReady) return whenReady;
    return null;
  }

  window.NostrSigners = {
    getActiveSigner,
    getDisplayNpub,
    ready,
    connectBunker: connectBunkerAndReturnIdentity,
    disconnectBunker,
  };
})();
