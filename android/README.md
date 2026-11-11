# Word5 for Android

Native Kotlin/Compose client, package `ai.otherstuff.word5`, Android 8.0 or later. It bundles the repository's exact word lists and daily UTC puzzle algorithm; no WebView or private-key import exists. Amber (`com.greenart7c3.nostrsigner`) is the sole sign-in/signing/encryption provider.

Play offline, enable hard mode before the first guess, view statistics and explicitly share the web-format purple/orange emoji result through Android's share sheet. The header and menu also expose native Social, profile editing, donations and explicit Nostr posting. Guest and each Amber account have separate local files. Signing in does not attach a guest game to an identity. Sign out retains the account's local save. The app disables Android cloud backup and device transfer of its decrypted local cache.

On Amber sign in, allow the requested kinds 27235/30078 and NIP-44 encrypt/decrypt, remembering permissions if you want automatic backup. Launch, resume, foreground retry and accepted guesses/settings changes fetch the server before merging/uploading. Sync defaults on for a new Amber account; its menu toggle can explicitly pause/resume automatic sync. Paused local saves remain intact, and an explicit restore/retry resumes it. Without remembered permission, automatic operations report pending approval; tap the compact **Encrypted Sync** status in the menu to open Amber. Cancellation, unavailable Amber, denied permission and network errors retain the local save and permit retry. No request launches another login method. Unmatched activity results after process death are ignored; the next foreground attempt fetches again.

## Backup and privacy

The production API is `https://otherstuff.ai/word5/`. Private save content is self-encrypted with NIP-44 and signed by the account; the server stores ciphertext and the signed envelope only. The client verifies both player records and request-bound server responses against the pinned public server key. It validates schema, owner, dictionary words, hard-mode clues, periods, bounded sizes and completion structure after decryption. Encryption is checked by an exact decrypt roundtrip before upload. Private-backup HTTPS requests never carry plaintext guesses, native statistics or decrypted backups. Automatic saves do not invoke completion/publication/relay routes. Sharing uses an explicit OS share action and contains no guesses. **Post to Nostr** previews and confirms a public emoji result plus summary statistics, then uses Amber kind 1 signing and relay acknowledgement. It also explicitly records today's score with the existing Word5 server; that score-validation request contains today's guesses, which never enter the public relay event. The separate score action explains this before submission. A restored completion without guesses can link to an existing server score but cannot invent a new submission. Confirmed posts whose scoreboard link fails retain a per-account pending event for explicit retry.

A first backup imports existing signed-server aggregate totals, streak, known period outcomes and reconstructable distribution into a versioned baseline. Missing archival evidence cannot be invented; a historical correction may have totals whose full per-game distribution is unavailable. The statistics UI identifies that limitation. The baseline stays encrypted in subsequent backups. Each fetch reconciles fresh signed web history so later browser completions also appear; unexplained empty/older server history cannot reset it. New server corrections can replace prior totals.

All native completed periods retain outcome, attempts and hard-mode status. Exact guesses are retained for unfinished games and completed games from the past 30 UTC days. Older exact guesses are omitted from the remote save; complete outcomes remain so totals, distribution and streaks survive. Gzip plus base64 keeps a tested 10,000-outcome history within NIP-44's plaintext bound. Decompression is capped at 2 MB; the schema permits at most 10,000 native periods and 10,000 baseline periods. Exceeding limits fails visibly without truncating the local save or uploading a partial backup.

Writes compare the last fetched event ID atomically. Conflict triggers a new read/decrypt/merge; an unknown/failed fetch never authorizes a write. A completed server outcome is immutable, including when restored as an older archive entry; a conflicting local completion cannot improve it. A local completion supersedes unfinished server state. Unfinished branches use most accepted guesses, with a lexical tie-break. Different periods union. Preference timestamps select newer hard-mode settings. Settings ties favor server state. After three conflicts, the local state stays pending for retry. A lost successful write is safe: the next attempt fetches and compares the returned state before writing again.

Local files are private app storage but decrypted while the device is unlocked. The transport has no private diagnostic logging. Amber/Android own their separate permission and process behavior.

## Build and verification

Use JDK 21+ (Android Studio's JBR works), Android SDK platform 37.2, and the checked-in Gradle wrapper:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

Run `bun run test` from the repository root for the server regressions. Android unit tests cover daily browser parity, duplicate letters/hard mode, strict schema/account validation, archive limits, legacy overlap, consuming restore/CAS/account isolation, server signature failure and offline reads. The signer double in consuming tests is disposable test infrastructure; it does not prove real Amber permissions or a physical-device roundtrip.

For a signed release set `WORD5_KEYSTORE`, `WORD5_STORE_PASSWORD`, and `WORD5_KEY_PASSWORD` in a protected environment; the alias is `word5`. Then run `./gradlew :app:assembleRelease :app:lintRelease`. Signing material must remain outside the checkout. Never use the debug certificate for publication. `tools/CertificateProof.java` emits public certificate and C1 app-key proof metadata for the release custodian; it does not provide the owner's Nostr signature or publish anything.

The Zapstore manifest deliberately has no license declaration because the repository supplies none. Before publication, review the exact APK hash/certificate, upload and verify public bytes, sign through the authorized owner's AP Vault, and verify relay admission and catalog listing. A build or simulated signer test alone is not release approval.

See [the server contract](../doc/native-android-backup.md) for deployment requirements.

## Web parity and native public flows

The web source remains the product reference. The game uses `#121213`, white WORD5, purple `#9333ea`, orange `#f97316`, grey `#3a3a3c`, and key grey `#818384`. Board tiles remain 48–58 logical pixels, square with 2px borders and 5px gaps, near the header; the countdown follows the board and keyboard stays at the bottom. Native status/navigation insets sit outside this content. Help/result/menu use custom Compose surfaces matching the DOM geometry rather than Material alert dialogs. Arimo, an openly licensed Arial-metric fallback, is bundled with its OFL notice; no proprietary system font is redistributed.

Social uses the existing public relay and HTTP contracts. Feed cards load public profiles/media; follows and challenge posts use explicit Amber signatures. Top Streaks uses aggregate rows, Top Scores supports 1/7/21 days and posted-only filtering, and comparisons use absolute puzzle periods and the existing score schedule. League reads and Week/Daily/member views are public-data operations; create/edit/leave/member-removal actions are explicit. Public profile kind 0 updates preserve unrelated metadata and upload selected images to Primal Blossom using the exact signed upload contract. No synthetic public writes are needed for automated validation.

The same Lightning address as the web app is shown as a QR and copyable address. Wallet opening is explicit; the app never initiates a payment itself. Chat honestly reports the existing web Amber limitation and does not fabricate access or introduce a different signer.

Manual profile streak corrections require an informed confirmation, then Amber signs the existing kind 5555 correction. A versioned private overlay changes native current/best streaks while retaining all immutable games, played/won totals and distribution. Boundary-day coverage ensures a game completed after correction still counts. Signed owner validation, stale-snapshot checks and deterministic timestamp/event-ID merge protect corrections. A failed public publish retains the local encrypted correction and exposes an explicit retry; it never silently publishes later.

The inner save schema is now `word5.native-backup.v2`, with strict migration of legacy v1. The encrypted outer schema and server transport remain unchanged. Older clients reject v2 rather than silently dropping corrections. Debug builds use `ai.otherstuff.word5.visualreview` so review fixtures cannot overwrite the release app or its data.

See [the native action inventory](web-parity.md) for the intentional Amber/private-default differences and action contracts. Review screenshots and run-specific evidence belong in ignored handoffs, not this repository's reusable documentation.
