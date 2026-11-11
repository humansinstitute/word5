# Amber and server history

On Android, choose **Login → Amber (Android) → Open Amber**, approve the account in Amber, then return to Word5. Use the same Nostr account on a new phone. Set the browser used for Word5 as the default browser so Android opens the return in the same browser storage. No private key import is required.

Signing also requires **Open Amber**. Word5 never opens the signer from a timer, a background sync, or a page load. If approval was cancelled, use **Cancel**, then **Retry score / restore history** in the result dialog. Reloading also retries a locally completed score. A public post signature can be resumed by repeating the post action after returning; Word5 reuses the approved payload even if the caller regenerated its timestamp. It never reuses a signature for different content, tags, kind or identity.

The browser transport follows [NIP-55 web applications](https://github.com/nostr-protocol/nips/blob/master/55.md), [Amber's request/return implementation](https://github.com/greenart7c3/Amber/blob/master/app/src/main/java/com/greenart7c3/nostrsigner/service/IntentUtils.kt), and [Chrome's Android intent syntax](https://developer.chrome.com/docs/android/intents). Requests target `com.greenart7c3.nostrsigner`; later signing requests include `current_user` for the saved account. The web callback supplies a result, rather than the native activity-result package extra, so the package is fixed to Amber. The connected public key and signer selection persist across reloads.

Callbacks use a random request ID, a 15-minute expiry, and a fragment so signed completion guesses do not enter HTTP logs or referrers. Word5 strips the fragment, checks the active identity, and verifies every returned signed event's signature, hash and complete requested payload. Unsolicited, expired, altered and wrong-account returns retain the prior identity. Pending requests and approved signatures survive a full document reload. The app asks again only through an explicit button.

## History authority

`GET api/player-history?pubkey=<64 lowercase hex characters>` reads the server database. It combines signed public score history with verified private completions, deduplicates by absolute puzzle period, prefers verified outcomes, applies signed correction baselines, and counts subsequent completions once. Same-day corrections use the signed completion timestamp, rather than treating all completions as occurring at midnight. Streaks follow consecutive UTC puzzle periods, including puzzle-number rollover. Local fallback also compares full period IDs, and expire after a missed day. The response contains only the aggregate/restoration summary; detailed per-game rows, private event IDs, signing timestamps and guesses stay internal.

The browser replaces cached counters with this response, keeps today's server-completed game completed, and saves game state per public key. Identity changes discard neither the outgoing account's saved game nor the original pre-migration browser snapshot (`word5-legacy-state-v1`). Concurrent old-account history responses cannot overwrite the new account. If the server is unavailable, the active account's local game is kept; a signed completion remains pending for retry. The server's unique player/period constraint remains the final duplicate guard.

The archive includes historical self-signed public results and explicit corrections; those are evidence of what that identity published, not newly verified historical guesses. Restoring a streak requires the relevant records to exist in the server database. A developer database can contain less history than production. Tests using generated identities do not establish any real player's current streak.

## Scope and verification

Browser extensions, NIP-46 bunkers and existing browser sessions retain their signer paths. Direct Amber support currently covers account selection and event signing. Optional encrypted unfinished-game/preferences sync and encrypted chat require NIP-44 methods; the direct Amber adapter reports them unsupported. Use an existing NIP-44-capable extension or NIP-46 connection for those features. The redundant background kind-5555 publication is skipped for Amber, avoiding an extra signer round trip after a public score.

Run `bun run test` for the server and existing regression suite. Run the full-page browser regression with a locally installed Playwright module:

```sh
WORD5_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs bun test/browser-amber-history.smoke.ts
```

The browser test uses a temporary in-memory server, real Nostr signatures, and isolated browser contexts. It covers forced full-document callbacks, tampering, cancellation, expired/unsolicited returns, timestamp regeneration, new-browser restoration, the next completion, duplicate reloads, conflicting cache, server outage, identity switching, and completion restoration during guess animation. It does not prove physical Android intent resolution, Amber approval UI behavior, Vanadium app-opening settings, or Android's browser selection. Those require a real-device check before production approval.
