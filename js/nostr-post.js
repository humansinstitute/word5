// Publishes a simple kind 1 score note to configured relays.
(function () {
  const DEFAULT_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.snort.social",
  ];
  const TAGGED_NPUB =
    "npub1khev409r2pa0k8a0an005mpvgv5swnyg54eh948ccxjsax97pm3srphq8m";
  const PROMO_LINE =
    "Check out more games daily this december at https://advent.otherstuff.ai/";
  let cachedTagPubkey = null;

  function buildContent(score, safeBase) {
    return [
      `Check out my score: ${score}!`,
      "",
      `At ${safeBase}`,
      "",
      PROMO_LINE,
      `nostr:${TAGGED_NPUB}`,
    ].join("\n");
  }

  async function publishScore({
    score,
    baseUrl,
    relays = DEFAULT_RELAYS,
    series = "otherstuffadventcal",
    game = "DontFSpiders",
    launchdate = "011225",
  }) {
    if (!window.NostrSigners) throw new Error("Signer module unavailable");
    const signer = await window.NostrSigners.getActiveSigner();
    const { SimplePool, nip19 } = await import(
      "https://esm.sh/nostr-tools@2?bundle"
    );
    const pool = new SimplePool();

    const safeBase =
      baseUrl ||
      (typeof window !== "undefined" ? window.location.origin : "https://");
    const content = buildContent(score, safeBase);

    if (!cachedTagPubkey) {
      try {
        const decoded = nip19.decode(TAGGED_NPUB);
        cachedTagPubkey =
          typeof decoded?.data === "string"
            ? decoded.data
            : decoded?.data?.pubkey || null;
      } catch (err) {
        console.warn("Failed to decode tagged npub", err);
      }
    }

    const tags = [
      ["series", series], // constant for leaderboard grouping
      ["game", game], // per-game identifier
      ["launchdate", launchdate], // fixed launch date for this game
      ["score", String(score)],
    ];
    if (cachedTagPubkey) {
      tags.push(["p", cachedTagPubkey, TAGGED_NPUB]);
    }

    const unsigned = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };

    const signed = await signer.signEvent(unsigned);

    // nostr-tools v2: publish() returns array of promises
    const pubPromises = pool.publish(relays, signed);
    const settledResults = await Promise.allSettled(pubPromises);

    const relayResults = relays.map((relay, i) => ({
      relay,
      status: settledResults[i].status === 'fulfilled' ? 'ok' : 'failed',
      reason: settledResults[i].reason?.message || undefined
    }));

    try {
      pool.close(relays);
    } catch (_) {}

    return {
      event: signed,
      relayResults,
      signerMode: signer.mode,
    };
  }

  window.NostrPost = {
    publishScore,
    DEFAULT_RELAYS,
    formatScoreContent: ({ score, baseUrl }) => {
      const safeBase =
        baseUrl ||
        (typeof window !== "undefined" ? window.location.origin : "https://");
      return buildContent(score, safeBase);
    },
  };
})();
