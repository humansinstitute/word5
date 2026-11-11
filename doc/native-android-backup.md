# Native Android private backup contract v1

The native Android client uses separate private backup endpoints. Existing browser completion, public leaderboard and relay contracts remain unchanged. Backup records must never be passed to those systems.

## Activation

Deploy the reviewed server code with the existing persistent Word5 SQLite database and configured `WORD5_NSEC`. A server without a signing key returns HTTP 503 for native backups. Set `WORD5_PUBLIC_BASE` to the exact canonical externally accessed base, including trailing slash; default `https://otherstuff.ai/word5/`. The reverse proxy may strip `/word5` before forwarding `/api/...`. Authorization uses the configured canonical external URL, never an untrusted forwarded header. A signing-key rotation requires a reviewed Android trust-pin update.

No new secret is required. Tables `native_backups` and `native_backup_auth` are added when the signing-enabled service starts. They contain account IDs, signed ciphertext, event IDs and short-lived replay IDs; no new plaintext native history table exists. Existing server history is unchanged. Keep normal database backups and access controls.

## Requests

POST `api/native-backup/read` with inner body `{}`; POST `api/native-backup/write` with inner body `{"previous":null-or-event-id,"event":<player-signed-ciphertext-event>}`. Both receive an outer envelope `{"body":<inner-body>,"auth":<signed-auth-event>}`.

This is a Word5-specific kind-27235 authenticated envelope, **not standard NIP-98 HTTP-body authorization**. Its `payload` hash is SHA-256 of UTF-8 JavaScript `JSON.stringify(innerBody)` with the inner object's received key order, no whitespace and JSON slash characters unescaped. Android serializes the inner body without escaped slashes before hashing. The canonical write object uses `previous` followed by `event`; event fields are `pubkey,created_at,kind,tags,content,id,sig`. Implementations must hash exactly what the server reserializes. No Unicode normalization occurs.

Auth kind 27235 has empty content, timestamp within 60 seconds of server time, a valid account signature, and these exact ordered tags:

```json
[["u","https://otherstuff.ai/word5/api/native-backup/read"],["method","POST"],["payload","<inner-body-sha256>"],["nonce","<fresh-lowercase-UUID>"]]
```

Use the write URL for writes. A fresh UUID is mandatory even within one second. Accepted auth event IDs are replay-protected transactionally until after the validity window. Entire request streams are capped at 110,000 bytes before JSON parsing.

The player backup event is kind 30078, authored by the authenticated account, signed within five minutes of server time for uploads, with precisely:

```json
[["d","word5:backup:v1"],["schema","word5.encrypted-backup.v1"]]
```

Content is NIP-44 self-encrypted ciphertext, 100–90,000 base64 characters. This event is stored server-side and never relayed. The address differs from browser's optional settings/unfinished-game records; those exclude stats and do not satisfy the native full-save requirement.

Writes atomically compare `previous` with the stored event ID, including null for initial creation. The signed response contains `conflict:true` and the current signed event if another device changed it; no overwrite occurs. Conflict consumes the auth nonce. Retry requires a fresh read and auth nonce. Auth replay returns 409; other invalid requests return 400/401, oversize 413, missing server key 503. Failures use fixed messages and never echo plaintext or request contents.

## Responses and migration

HTTP 200 is `{"event":<server-signed-response>}`. Verify the NIP-01 hash, BIP-340 signature, pinned server author, kind 27235, timestamp within 120 seconds and exact ordered tags:

```json
[["request","<auth-event-id>"],["p","<authenticated-account>"],["schema","word5.backup-response.v1"]]
```

The signed content contains `event` (player-signed record or null); reads also include `history`, the existing server summary plus authenticated `coveredPeriods`, per-period `outcomes` and reconstructable `distribution`. These additional fields are **not** exposed by the existing unauthenticated `api/player-history` route. Signed null prevents a substituted empty response from authorizing a destructive first write. The initial baseline retains archive totals/corrections, last period, current completion, covered periods and known outcomes. Some corrections lack complete historical records, so known distribution can differ from corrected totals; missing outcomes are not fabricated. Future native saves encrypt this baseline along with new play. Every fetch reconciles fresh signed server history, including later browser completions. An unexplained smaller/empty archive cannot replace the stored baseline; a server correction can change its totals only when its signed creation timestamp is newer (same-time ties choose the lexically greater event ID). The private baseline carries both correction ID and original signed creation time; the fetch time is never used as correction chronology. Covered periods prevent native/browser overlap from counting twice.

## Decrypted save

NIP-44 plaintext is `word5.gzip.v1:` plus base64 gzip of JSON schema `word5.native-backup.v1`. The object contains exact keys `schema,owner,hardMode,hardUpdated,baseline,games`. Games are `[absoluteUtcPeriod,hardMode,guessesOrArchivedOutcome]`; outcomes 1–6 are a win in that many attempts, 7 is a loss. Recent/unfinished games hold the exact accepted guess array. Older completed games retain every outcome/attempt count/hard flag but omit exact guesses after 30 days. The versioned baseline includes the imported totals and known outcome evidence.

Validate strict keys, types, account, dates, dictionary words, no guesses after a win, hard-mode clues and all numerical bounds after decryption. Maximum plaintext transported to Amber is 60,000 bytes, decompressed save 2 MB and 10,000 native plus 10,000 baseline periods. Bounds fail visibly and keep local state; no partial history upload or silent truncation is permitted. A 10,000-outcome archive is covered by Android roundtrip tests.

Fetch/decrypt/merge precedes every upload. The remote completed outcome is immutable; local completion only supersedes unfinished state. Unfinished branches select most accepted guesses then lexical order, periods union and settings use their own timestamp. Three conflicts leave the save pending. A local write during an upload triggers another fetch/merge pass. Missing permission, cancellation, account change, offline operation or unknown fetch never permits an optimistic blank overwrite. Account switches cancel pending work and check the generation after asynchronous results. Local guest state is kept separately.

Tests: `bun run test` at repository root, and `./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug` in `android`. Production proxy activation and real remembered Amber permissions still need release-level checks; disposable signer doubles are not device proof.
