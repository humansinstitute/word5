// Signer resolution: prefer explicit linked signers, otherwise session key.
(function () {
  const { whenReady, getPlayer } = window.NostrSession || {};
  let memoryBunkerSigner = null;
  let memoryBunkerUri = null;

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

    const clientSecret = pure.generateSecretKey();
    const signer = new nip46.BunkerSigner(clientSecret, pointer);
    await signer.connect();
    await signer.getPublicKey();

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
        nip44Encrypt: typeof window.nostr.nip44?.encrypt === "function"
          ? (pubkey, plaintext) => window.nostr.nip44.encrypt(pubkey, plaintext) : null,
        nip44Decrypt: typeof window.nostr.nip44?.decrypt === "function"
          ? (pubkey, ciphertext) => window.nostr.nip44.decrypt(pubkey, ciphertext) : null,
        mode: "nip07",
      };
    }
    if (player?.auth_mode === "bunker" && player?.bunker_uri) {
      const signer = await connectBunker(player.bunker_uri);
      return {
        getPublicKey: () => signer.getPublicKey(),
        signEvent: (evt) => signer.signEvent(evt),
        nip44Encrypt: typeof signer.nip44Encrypt === "function"
          ? (pubkey, plaintext) => signer.nip44Encrypt(pubkey, plaintext) : null,
        nip44Decrypt: typeof signer.nip44Decrypt === "function"
          ? (pubkey, ciphertext) => signer.nip44Decrypt(pubkey, ciphertext) : null,
        mode: "bunker",
      };
    }
    if (player?.privkey) {
      const { finalizeEvent, nip44 } = await import(
        "https://esm.sh/nostr-tools@2?bundle"
      );
      const sk = hexToBytes(player.privkey);
      const conversationKey = (pubkey) => nip44.v2.utils.getConversationKey(sk, pubkey);
      return {
        getPublicKey: async () => player.pubkey,
        signEvent: async (evt) => finalizeEvent(evt, sk),
        nip44Encrypt: async (pubkey, plaintext) => nip44.v2.encrypt(plaintext, conversationKey(pubkey)),
        nip44Decrypt: async (pubkey, ciphertext) => nip44.v2.decrypt(ciphertext, conversationKey(pubkey)),
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
