// A game page load is a visit. The server stores only a per-puzzle keyed hash
// of this existing session public key, never the public key itself.
(async function () {
  try {
    const player = await window.NostrSession.whenReady;
    if (!player?.pubkey) return;
    await fetch('api/visit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionPubkey: player.pubkey }),
    });
  } catch (_) {
    // Visit tracking must never interrupt play.
  }
})();
