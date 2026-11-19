# 1.0.9 (10)

- Chat profiles show loading, offline, retry and missing states, automatically retry with delayed exponential backoff and jitter, and retain previously loaded names/photos.
- Tap a chat avatar for a read-only photo, name, bio and full copyable npub. Unsafe or broken images retain a fallback.
- Profile reads are bounded and cancelled across room, account and lifecycle changes; message results, drafts and scroll stay independent.

# 1.0.8 (9)

- Collapse chat navigation into one compact toolbar, leaving more room for messages with the keyboard open.
- Keep day switching and refresh in the toolbar, room expiry behind the room title, and Play/Social in the menu.

## 1.0.7 (8)

- Keep accepted lifetime bests separate from recovered game counts and current streaks.
- Consume the shared server public-history contract for scores, duels and leagues.
- Persist private completion retries independently of optional Nostr publication and encrypted backup; preserve account isolation and offline/rollover recovery.
- Preserve accepted server lifetime floors while a local correction proposal awaits review.

# 1.0.6

Visit yesterday’s chat alongside today using simple navigation buttons. Each room keeps its own completion gate, draft, cached messages, scroll position and correctly dated result badges. Yesterday remains available before finishing today when its result was already verified. Rooms close after their day as yesterday; expired keys and local room state are removed. Today’s private-game validation still requires informed confirmation and never posts to Nostr. Existing native games, statistics, hard-mode settings and encrypted backup remain unchanged.

# 1.0.5

Daily chat is now native: one date-and-word room for today’s finishers, encrypted messages, profile photos/names and result badges, cached incremental refresh, offline retry and explicit Amber approval/cancellation. Private native completions unlock only after confirming score validation with Word5; no public Nostr post is created. Already verified restored/web completions can join without resubmitting guesses. Rooms, keys, drafts and cached messages clear at the next word or account change. Existing account saves, statistics, hard-mode preferences and encrypted backup remain unchanged.

# 1.0.3

Completed games now keep a View result / Post to Nostr action below the board and in the menu, including after closing dialogs or returning from Social. Posting still requires preview and confirmation. Existing pending score links reuse the confirmed post; successful publication is retained per account and puzzle. The release is named Word5 without Test. Existing account saves and encrypted backup are preserved.

# 1.0.2-test

Closing a nested result action now returns to the result underneath, matching the web app. Includes Back, outside dismissal and Donate/Score close paths. The prior TEST build remains an immutable published artifact.

# 1.0.1-test

Restores the existing web Word5 presentation in native Compose: compact white WORD5 header and navigation, bounded square board, purple/orange/grey feedback, countdown below the board, bottom keyboard, menu, help, result and statistics dialogs. Native Social includes feed, follows/duels, score/streak leaderboards, comparisons, challenge cards and league views. Profile editing and image upload use the existing Nostr/Blossom contracts. Donation uses the same Lightning address.

Amber remains the only signer. Encrypted complete-state backup remains automatic; public results, scores, profile/contact/league changes and stats corrections require explicit actions. Manual streak corrections retain immutable game records and survive encrypted restoration. Native backup schema v2 strictly migrates v1; no server contract change. Development builds use a separate visualreview application ID.

This is a TEST review candidate. Release custody and test publication are handled separately after quality checks.

# 1.0.0

Native Android Word5 with the same daily puzzle and word lists as the web game, six-guess keyboard, hard mode, statistics and result sharing. Amber-only sign in supports automatic encrypted server backups and restore, offline saves, account separation and retry. Existing server totals and known history migrate into the encrypted save. Older completed games retain outcomes and attempt counts; exact recent and unfinished guesses remain available.

Production activation, Amber device approval and store publication require release review. See README.md for the tested scope.
