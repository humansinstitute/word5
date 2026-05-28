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
