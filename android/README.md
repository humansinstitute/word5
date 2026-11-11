# Word5 for Android

Native Kotlin/Compose client, package `ai.otherstuff.word5`, Android 8.0 or later. It bundles the repository's exact word lists and daily UTC puzzle algorithm; no WebView or private-key import exists. Amber (`com.greenart7c3.nostrsigner`) is the sole sign-in/signing/encryption provider.

Play offline, enable hard mode before the first guess, view statistics and explicitly share an emoji result through Android's share sheet. Guest and each Amber account have separate local files. Signing in does not attach a guest game to an identity. Sign out retains the account's local save. The app disables Android cloud backup and device transfer of its decrypted local cache.

On Amber sign in, allow the requested kinds 27235/30078 and NIP-44 encrypt/decrypt, remembering permissions if you want automatic backup. Launch, resume, foreground retry and accepted guesses/settings changes fetch the server before merging/uploading. Without remembered permission, automatic operations report pending approval; use **Retry backup** to open Amber. Cancellation, unavailable Amber, denied permission and network errors retain the local save and permit retry. No request launches another login method. Unmatched activity results after process death are ignored; the next foreground attempt fetches again.

## Backup and privacy

The production API is `https://otherstuff.ai/word5/`. Private save content is self-encrypted with NIP-44 and signed by the account; the server stores ciphertext and the signed envelope only. The client verifies both player records and request-bound server responses against the pinned public server key. It validates schema, owner, dictionary words, hard-mode clues, periods, bounded sizes and completion structure after decryption. Encryption is checked by an exact decrypt roundtrip before upload. HTTPS requests never carry plaintext guesses, native statistics or decrypted backups. Native saves do not invoke completion/publication/relay routes. Sharing uses an explicit OS share action and contains no guesses.

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
