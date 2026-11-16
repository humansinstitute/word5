# Word5 calculation and historical reconciliation

`word5.calculation.v1` lives in the Word5 server. Tower stores coordination records, never game truth. The same `acceptedOutcomes`, `playerReport` and `publicBoard` functions supply restoration, public histories, scores, lifetime streaks, comparisons, snapshots and recaps. Web and Android render this accepted projection. Offline local outcomes remain provisional until acknowledgement.

## Evidence and accepted outcomes

`raw_events` retains original signed event JSON. Import accepts only genuinely signed, parsed public Word5 scores/corrections, never encrypted backups, unrelated events or server attestations masquerading as player reports. `public_score_history` is a rebuildable projection, separate from `game_submissions.verified_completion`.

A logical outcome is `(pubkey, absolute UTC puzzle period)`. Display puzzle numbers wrap every 1,000 periods; they are not identifiers. Legacy posts infer the closest preceding matching period from signed creation time. Explicit periods must agree with the puzzle and cannot be future periods. Duplicate agreeing formats count once. Conflicting public legacy results are excluded with an explicit unresolved conflict; sorting by latest timestamp cannot resolve them. Server-validated completions win in the private ledger, preserving conflicting raw public evidence.

A private completion must not alter public output, even indirectly by resolving a public conflict or changing provenance. The public projection consults validated outcomes only after explicit publication confirmation. Private event IDs, guesses, unpublished results, counts and completion flags never enter public histories, boards or relay snapshots.

## Counters and lifetime baselines

Played counts accepted days, won counts non-loss days, and distribution counts known winning attempt counts. Points are recomputed from results: `1→10, 2→7, 3→5, 4→3, 5→2, 6→1, X→0`. UTC rolling windows include today and the preceding `days−1` puzzle days. Ties use points, wins and games descending, then pubkey ascending. Public comparison and league displays sum only server-selected rows in their inclusive UTC windows.

Current streak follows consecutive winning UTC periods and expires after a missed day. Lifetime best is separately floored by the accepted baseline; incomplete recovered history cannot downgrade it. A lifetime baseline does not create wins, played counts, distribution entries or an active run. It may exceed recovered wins.

`lifetime_best_decisions` retains provenance, signed source event hash/time when present, actor, review time, reason, effective time and explicit supersession. An owner-confirmed baseline is distinct from self-published evidence. The latest eligible claim since the latest correction is a **proposal**, never an unconditional highest-max. Downward/conflicting proposals stay withheld for review. New claims cannot silently inflate an accepted baseline. A reviewed lower decision must explicitly supersede its predecessor.

`reviewed_correction_anchors` separately approves signed correction aggregate/current-run seeds. Unreviewed corrections remain immutable evidence without changing accepted counters. A reviewed correction covers earlier periods and known boundary-day outcomes; subsequent accepted outcomes count once. Unknown historical distribution stays unknown. Local offline outcomes before a correction aggregate cutoff remain preserved without counting the aggregate twice.

## Owner access and offline retry

`GET /api/player-history?pubkey=...` is public-only compatibility. `POST /api/player-history` takes a player-signed kind 30078 event, schema `word5.history-request.v1`, empty content, fresh within five minutes; the signature author is the only requested owner. It returns private restoration outcomes/distribution and accepted baseline provenance. No query parameter grants private access. The browser shares this reader across statistics, repair and check-streak screens. Native backup uses its existing request-bound signed response and pinned server identity.

Public `/api/scores`, `/api/leaderboard`, `/api/social-history`, `/api/top-streaks` and `/api/comparison` always use the public subset, including legacy `published=false` requests. Scores distinguish reconciled historical reports from validated completions in their contract and history provenance. Private data is never an alternate public filter.

Browser and native account-specific durable completion outboxes persist drafts/signatures before sending, retain them across failure/relaunch/UTC rollover, and dequeue only after server success. Guest saves remain separate from signed-in accounts. Native encrypted backup remains independent. Optional Nostr publication never gates completion storage. A matching outcome and ordered guesses can retry with a new signature without creating another logical game; a changed completed outcome cannot replace it.

Offline signed completion evidence must match its original UTC puzzle day, dictionary, ordered guesses, result, hard-mode clues and future-skew bounds. A signed timestamp alone does not prove contemporaneous play. `completion_basis` and `observed_at_ms` distinguish receipt during the current puzzle period, validated offline client evidence, and unclassified legacy rows. Historical public imports never set `verified_completion`.

## Reversible migration tooling

Use `scripts/reconcile-history.ts` on an authorized local/instance database. Outputs are private operational files, never source-controlled or copied into a public artefact.

```sh
bun scripts/reconcile-history.ts snapshot <database> <new-private-snapshot>
bun scripts/reconcile-history.ts preview <snapshot> <input.json> <new-manifest.json>
bun scripts/reconcile-history.ts apply <database> <input.json> <new-backup> <reviewed-manifest.json> <batch-id>
bun scripts/reconcile-history.ts rollback <database> <batch-id>
```

Snapshot uses SQLite `VACUUM INTO` for a coherent standalone backup, with SHA-256 and private file permissions. Preview runs against a disposable file copy. Input pins a fixed cutoff, exact public signed events, proposed baseline decisions and separately reviewed correction anchors. Its SHA-256 binds the batch. The manifest includes every affected player’s before/after counters, distribution, current run, lifetime baseline, points, provenance and conflicts; the public-only views are separately identified.

Apply takes a fresh backup, checks the exact reviewed manifest inside one transaction, and records inserted projections/snapshots. A repeated batch is idempotent; changed input or stale reviewed evidence fails atomically. Completions received after the fixed cutoff do not invalidate or get overwritten by the historical import. Re-evaluate any other meaningful drift before applying.

Rollback removes only this batch’s imported projections/snapshots and revokes optional correction anchors, preserving all accepted lifetime floors, raw evidence, prior records, explicit later publications, encrypted backups and new completions. Lowering an accepted floor requires a separate explicit reviewed superseding decision. It never restores an old whole database over new games. Existing signed snapshots/relay publications are not erased by database rollback; activation must happen only after review, and published corrections require a separate explicit delivery plan.

A prepare-only operator snapshot API is available at `POST /api/reconciliation/snapshot`, disabled unless both `WORD5_RECONCILIATION_OPERATORS` (exact public hex allowlist) and `WORD5_RECONCILIATION_INSTANCE` (reviewed instance marker) are configured. Standard `Authorization: Nostr <base64 event>` signs exact raw HTTP body bytes `{"app":"word5","instance":"<reviewed instance>"}` using NIP-98 with a unique nonce, 60-second freshness and bounded in-process replay tracking. Body reading is capped at 1,024 bytes, independently of content-length. Canonical URL comes from configured `WORD5_PUBLIC_BASE`; forwarded headers never select the target. No caller-selected paths are accepted. Responses are no-store, carry SHA-256 plus capture-start/finish bounds, and temporary private files are removed. The coherent snapshot boundary lies within that interval; the start timestamp is not asserted to be an exact commit boundary. Full backup contains sensitive tables and must stay in private ignored storage. Prefer supported authorized instance execution of the snapshot CLI where available; deployment inspection alone grants no volume access.

## Consumers and activation

Inspected consumers: browser `index.html`, `nostr-ui.js`, `social-board.js`, `league.js`, player sync; native Android game/backup/corrections/social/duels/leagues; server public-data and announcement jobs. Repository and nearby Swift/Flutter/Kotlin discovery found the existing Android client and no additional Word5 native implementation. The adjacent older `word5-server` checkout is a web/server copy of the same origin, not another native client. No iOS support is claimed.

Coordinate server contract, reviewed migration and Android upgrade. Older clients may reject a baseline whose accepted lifetime best exceeds recovered wins; they must retain their existing save rather than overwrite it. Android release candidates require a higher version, the established durable certificate, device/upgrade validation and manager-reviewed AP Vault/Zapstore delivery. Source readiness does not mean live activation.

Relay catch-up uses supported `#t` filters, bounded independent per-relay cursors and saturation guards. Historical `repair()` has separate cursors and cannot rewind normal catch-up. Query completion or an empty response never proves relay retention; inaccessible windows and unknown completeness remain explicit.

## Protected staged activation

The operator routes use the same NIP-98 header and instance binding as snapshot. Bodies always include `app` and `instance`; raw request reading is capped at 20 MB (snapshot: 1 KB), with no caller-selected paths or SQL.

- `preview`: add `input`; calculate only on a disposable coherent database copy.
- `stage`: add `batchId`, `input`, `manifest`, `manifestSha256`; verify logical hashes, reviewer actor and exact regenerated preview, then exclusively store the original signed request in fixed private pending storage.
- `status`: add `batchId`; recover safe staging/application receipt after uncertain delivery.
- `apply`: same body as stage, permitted only after canonical activation; back up before transactional import.
- `rollback`: add `batchId`, `inputSha256`, `reason`; back up, reverse batch projections/optional anchors and retain accepted lifetime floors and new completions.

The snapshot-only rollout tree preserves the exact prior application and assets; its operator preview/stage module is isolated from the old runtime calculations. It checks coverage of all currently displayed eligible leaderboard lifetime bests. `preservedPublicBests` pins those prior achievements and their snapshot/source provenance. No downward candidate can replace one without an explicit reviewed superseding decision.

For the canonical rollout, set `WORD5_RECONCILIATION_REQUIRE_REVIEW=1` and exact `WORD5_RECONCILIATION_ACTIVATE_BATCH`. Before creating the Word5 service, publishers or listener, startup verifies the persisted original stage signature/body/actor/instance/hashes at the staging timestamp, takes a fresh backup and applies the reviewed batch atomically. Persisted approvals do not become invalid merely because deployment takes longer than the request-auth freshness window. Repeated boot reuses an already applied matching batch. Changed manifests or invalid proofs fail without partial schema/data migration. New completions between stage and startup are selected by server receipt time, with legacy `accepted_at` fallback, and remain intact. After a deliberate rollback, clear the old activation-batch environment binding before a later restart; reactivating a rolled-back batch is refused.
