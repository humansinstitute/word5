// Signer resolution: prefer NIP-07 extension, otherwise session key.
(function () {
  const { whenReady, getPlayer } = window.NostrSession || {};

  function hexToBytes(hex) {
    if (!hex) return new Uint8Array();
    const out = [];
    for (let i = 0; i < hex.length; i += 2) {
      out.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return new Uint8Array(out);
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

  async function ready() {
    if (whenReady) return whenReady;
    return null;
  }

  window.NostrSigners = { getActiveSigner, getDisplayNpub, ready };
})();
