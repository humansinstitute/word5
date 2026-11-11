# 1.0.2-test

Closing a nested result action now returns to the result underneath, matching the web app. Includes Back, outside dismissal and Donate/Score close paths. The prior TEST build remains an immutable published artifact.

# 1.0.1-test

Restores the existing web Word5 presentation in native Compose: compact white WORD5 header and navigation, bounded square board, purple/orange/grey feedback, countdown below the board, bottom keyboard, menu, help, result and statistics dialogs. Native Social includes feed, follows/duels, score/streak leaderboards, comparisons, challenge cards and league views. Profile editing and image upload use the existing Nostr/Blossom contracts. Donation uses the same Lightning address.

Amber remains the only signer. Encrypted complete-state backup remains automatic; public results, scores, profile/contact/league changes and stats corrections require explicit actions. Manual streak corrections retain immutable game records and survive encrypted restoration. Native backup schema v2 strictly migrates v1; no server contract change. Development builds use a separate visualreview application ID.

This is a TEST review candidate. Release custody and test publication are handled separately after quality checks.

# 1.0.0

Native Android Word5 with the same daily puzzle and word lists as the web game, six-guess keyboard, hard mode, statistics and result sharing. Amber-only sign in supports automatic encrypted server backups and restore, offline saves, account separation and retry. Existing server totals and known history migrate into the encrypted save. Older completed games retain outcomes and attempt counts; exact recent and unfinished guesses remain available.

Production activation, Amber device approval and store publication require release review. See README.md for the tested scope.
