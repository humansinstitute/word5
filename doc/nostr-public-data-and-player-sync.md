# Word5 public relay data and encrypted player sync

## Public data contract

Word5 uses the server database for calculation and archival state, then distributes signed public results through Nostr. It does not ask consumers to reconstruct a board from a global relay window.

Word5 public snapshots are addressable **kind 30763** events using schema `word5.leaderboard.v1`. Kind 30763 was not present in the official [Nostr registry of kinds](https://github.com/nostr-protocol/registry-of-kinds/blob/master/schema.yaml) when checked on 20 October 2026. This is a documented Word5 interoperability contract, not a claim that the kind is an adopted NIP. Kind 30078 is deliberately excluded because NIP-78 is application-specific storage.

The server publishes two records:

| Dataset | Exact `d` value | Evidence basis | Source |
| --- | --- | --- | --- |
| All-time Top Streaks | `word5:streaks:all-time:v1` | `signed-public-history` | Highest accepted player-signed public claim in the complete server archive |
| Completed daily scores | `word5:daily:<periodId>:v1` | `server-verified` | Verified server completions that the player also chose to post publicly |

Top Streaks rows contain `rank`, `pubkey`, `maxStreak`, the related current claim fields, `sourceEventId`, and any applicable `latestCorrectionEventId`. A historical claim such as Daniel's 114 remains `signed-public-history`; the server signature certifies the snapshot and archive calculation, not that the historical puzzle run was server-verified.

Daily rows contain `rank`, `pubkey`, `points`, `result`, `hardMode`, and the player's public `sourceEventId`. Private completion-event IDs and guesses are never included. The daily cutoff is 00:21 UTC after the completed period. A late confirmed public post can create a newer version at the same address. Empty snapshots are valid and let consumers distinguish “no public scores” from unavailable data.

Every snapshot has these tags:

```json
[
  ["d", "word5:streaks:all-time:v1"],
  ["t", "word5"],
  ["t", "word5scoreboard"],
  ["schema", "word5.leaderboard.v1"],
  ["dataset", "top-streaks"],
  ["basis", "signed-public-history"],
  ["generated_at", "<unix-seconds>"]
]
```

Daily events also carry `period`, `date`, and `puzzle` tags. Content is compact JSON:

```json
{
  "schema": "word5.leaderboard.v1",
  "dataset": "daily-scores",
  "basis": "server-verified",
  "generatedAt": 1792542060,
  "cutoff": {
    "periodId": 20746,
    "puzzle": 746,
    "date": "2026-10-20",
    "cutoffAt": 1792542060
  },
  "rows": [
    {
      "rank": 1,
      "pubkey": "<player-hex-pubkey>",
      "points": 10,
      "result": "1",
      "hardMode": false,
      "sourceEventId": "<player-signed-public-event-id>"
    }
  ]
}
```

Consumers must configure the Word5 server's hex public key and use an exact address filter. They must verify the event signature, author, kind, exact `d`, schema, and content before using it:

```json
{
  "authors": ["<WORD5_SERVER_HEX_PUBKEY>"],
  "kinds": [30763],
  "#d": ["word5:streaks:all-time:v1"]
}
```

```json
{
  "authors": ["<WORD5_SERVER_HEX_PUBKEY>"],
  "kinds": [30763],
  "#d": ["word5:daily:20746:v1"]
}
```

No global `limit` scan is part of the contract. A consumer may use `limit: 1` after supplying the exact author, kind, and `d` because that coordinate is addressable.

## Relay delivery and retry

The existing server-signed kind 30762 GameStr score is now sent, with one identical event ID, to the union of `WORD5_RELAYS` and `GAMESTR_RELAYS`. Duplicate relay URLs are removed. Kind 30763 snapshots go to `WORD5_RELAYS`.

`relay_event_outbox` is populated before network I/O with the complete signed event JSON and one row per target relay. Each relay has independent pending/published/failed state. Restarts and uncertain acknowledgements retry the exact stored event; duplicate/already-stored responses count as success. One relay accepting an event does not cause a new signature for the remaining relays. Deliveries use a one-minute lease, a 15-second timeout, exponential retry delay, and a twelve-attempt terminal cap. `/api/health` reports category/status counts without exposing event content or keys.

Snapshot inputs are hashed without generation metadata. If the same dataset is reconsidered after restart, Word5 reuses the already signed event and restores any missing outbox rows. A changed dataset creates a newer signed addressable version with a monotonically increasing `created_at`, preventing a delayed older retry from replacing newer data at a conforming relay.

Existing kind-30078 server attestations remain readable legacy evidence. They are not expanded into the public leaderboard contract.

## Encrypted NIP-78 player sync

Player sync is explicitly opt-in through **Encrypted Sync** in the player menu. Local play, local saving, scoring, and posting continue normally when sync is off or the signer does not support NIP-44.

The player signs addressable kind 30078 records under their own pubkey and encrypts content to that same pubkey with NIP-44:

- `word5:settings:v1` contains schema `word5.settings.v1`, an `updatedAt` millisecond timestamp, and supported preferences (`hardMode` in v1).
- `word5:game:<periodId>:v1` contains schema `word5.game.v1`, the exact period, `updatedAt`, completed guesses, and the hard-mode flag needed to resume an unfinished game.

The outer event exposes only the author, timestamp, versioned `d`, and `schema=word5.encrypted-state.v1`; content is ciphertext. The app never includes an nsec/private key, session secret, target answer, solution, aggregate stats, completion proof, or leaderboard evidence. Keyboard colours are reconstructed from guesses and the locally derived puzzle answer rather than synchronized. Completed games are not published as progress records.

On enable or sign-in, the client queries configured Word5 storage relays using both exact filters:

```json
{
  "authors": ["<PLAYER_HEX_PUBKEY>"],
  "kinds": [30078],
  "#d": ["word5:settings:v1"],
  "limit": 10
}
```

```json
{
  "authors": ["<PLAYER_HEX_PUBKEY>"],
  "kinds": [30078],
  "#d": ["word5:game:20746:v1"],
  "limit": 10
}
```

The client independently verifies signature, author, kind, exact `d`, outer schema, ciphertext size, decrypted schema, exact allowed keys, types, period, guess format, and maximum unfinished guess count. It tries valid candidates newest-first and ignores malformed records. A record applies only when its `updatedAt` is newer than local state.

Before restoring progress, the client signs a short-lived, server-only `word5.sync-status.v1` request to `POST api/completion/status`. The request is never relayed. If the server already has a verified completion for that player and period, remote unfinished state is ignored. A completed local state also always wins.

Settings changes and completed guesses create debounced checkpoints; typing individual letters does not. Relay results are reported in the menu. Partial success names the accepted/target count, while total failure says the local game was kept. Turning sync off stops reads and writes but does not attempt relay deletion.

NIP-07 works only when the extension exposes both `nip44.encrypt` and `nip44.decrypt`. NIP-46 bunker mode uses the corresponding remote-signer methods. Local/imported session keys use nostr-tools NIP-44 v2 locally. Unsupported signers show a clear unsupported state and do not affect play.

## Compatibility and key rotation

The version is part of each `d` value and decrypted schema. A breaking payload change must use new `d` and schema versions; v1 readers ignore unknown versions. Additive public leaderboard changes should preserve all documented v1 fields or publish a new schema/address contract.

A server signing-key rotation changes every public address because an addressable coordinate includes the author. Operators must publish the new server pubkey out of band, update consumers, and preferably overlap old/new publication during migration. Old events are not re-signed or relabelled.

Player sync is intentionally bound to one npub. Rotating to a new player key creates a different NIP-78 address and cannot decrypt the old key's self-encrypted records. Migration requires control of the old signer and an explicit application-level export/import flow; Word5 does not copy private state across identities automatically.
