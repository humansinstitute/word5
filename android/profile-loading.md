# Native public profile loading

`PublicProfiles` owns one `ProfileLoader` for the app. Chat observers receive a
verified cached event first, then verified newer relay events as they arrive.
Profile requests never use Amber, game saves, room keys, chat text or public writes.

The loader buffers addresses for 200 ms, batches up to 200 addresses, joins repeated
addresses, and limits active batches to four. `ProfileRelayPool` multiplexes
subscriptions on one socket per endpoint. It sends CLOSE on completion/cancellation
and closes idle sockets after 250 ms. A room/account/lifecycle change cancels its
observers; the last observer cancels its batch. Chat tickets and scope checks keep
late results from repopulating a dismissed room or replacing a local profile edit.

Primary reads use the existing public relay list. Each stage has a 3.5 second
budget, including up to three rounds for relay-limited partial results. Unresolved
addresses then use the fixed lookup endpoints purplepag.es and relay.primal.net.
No relay URL from profile metadata or other untrusted input is followed. Each
received event must match the exact requested author and kind, pass canonical
hash/signature verification and contain usable metadata. Malformed/forged events
are isolated. Newest timestamp wins; equal timestamps select the lowest event id.
EOSE is a boundary for one request, not proof that a person has no public profile.
An empty result with any failed/timed-out endpoint stays retryable. Even a completed
empty lookup is worded as absence on the checked relays, with a short retry TTL.

`ProfileEventCache` stores only verified public kind-0 events in app-private
`public-profiles-v1.json`: at most 256 events, at most 12 KB per serialized event.
Cold loading revalidates signatures, event kinds, timestamps and metadata; corrupt
entries are ignored separately. Replacement and size limits apply before atomic
file replacement. Account changes clear presentation state while this public-only
cache remains reusable. Stale profiles display during network refresh/failure.
The cache is an optimization; it does not establish global freshness or absence.

The design borrows these focused principles from the primary Applesauce sources:

- [Address loader](https://github.com/hzrd149/applesauce/blob/master/packages/loaders/src/loaders/address-loader.ts): cache-first stages, batching, joining and streaming.
- [Address pointer helpers](https://github.com/hzrd149/applesauce/blob/master/packages/loaders/src/helpers/address-pointer.ts): exact address matching.
- [Loader helpers](https://github.com/hzrd149/applesauce/blob/master/packages/loaders/src/helpers/loaders.ts): bounded stages and retries while partial batches make progress.
- [Loader guide](https://github.com/hzrd149/applesauce/blob/master/apps/docs/loading/loaders/address-loader.md): app-wide lifetime and lookup relays.
- [Profile model](https://github.com/hzrd149/applesauce/blob/master/packages/core/src/models/profile.ts): verified replaceable events followed by metadata extraction.

This implementation intentionally uses a fixed endpoint list rather than arbitrary
relay hints, and has short idle socket lifetimes suited to the native chat screen.
It is Kotlin/OkHttp, with no JavaScript runtime or WebView.

## Verification and diagnostics

`ProfileLoaderTest` uses real local WebSockets with disposable signed events. It
covers withheld EOSE and hung peers, fallback lookup, partial batches, joined
connections, invalid/forged isolation, relay extensions, timestamp/id ordering,
cache bounds/restart/reverification and last-subscriber cleanup. The independently
JavaScript-signed fixture in `src/test/resources` contains no real person's data.
`ChatProfilesTest` covers progressive tickets, stale display and scope cancellation.

The debug-only `ProfileProbeActivity` accepts a public `pubkey` intent or a JSON
configuration in the separate debug app's `files/profile-probe.json`. Optional
`primary`, `lookup`, `stageMs` and `keys` configure controlled transport checks;
`legacy` plus `relay` invokes the old EOSE-dependent generic query for comparison.
Load a captured public-event array (`[{"event":{...}}]`) into
`files/profile-fixture.json` to check Android org.json, hashing, JNI verification
and metadata extraction. Results go to `files/profile-report.json`; the probe's
public cache is `files/probe-public-cache.json`. Keep all run-specific inputs,
outputs and actual public-person fixtures in ignored handoffs. Do not commit them.

The debug package permits cleartext solely for loopback/adb-reversed test relays;
the release package forbids cleartext and excludes both diagnostic activities.
`ChatReviewActivity` mode 6 can observe a supplied `publicKey` through the real
public loader while keeping its surrounding chat rows simulated and signer-free.

Android and the JVM test org.json library have different escaping behavior. Both
captured real events and independent Unicode edge events must be checked on Android;
a JVM-only hash mismatch is not evidence of a native ingestion failure. This release
keeps the existing Android event serialization/signing contract unchanged.
