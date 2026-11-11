# Native Word5 action inventory

The existing `index.html`, `social.html`, `chat.html` and their JavaScript are the product reference. Android renders native Compose throughout. It has no WebView, private-key entry or alternative sign-in chooser. Public content links and the Lightning wallet URI intentionally open the corresponding external application.

## Play, header and menu

| Web action | Native equivalent and contract |
| --- | --- |
| Menu | Same left header placement and compact dropdown. |
| Donate lightning icon / menu Donate | Native donation card, same Lightning address and QR, tap to copy or explicitly open a wallet. No payment is initiated by the app. |
| Play / Social navigation | Native screens; Social retains feed, follows/duels, leaders and leagues. |
| Help | Same purple/orange/grey legend and rules in a custom native surface. |
| Hard Mode | Available only before the first guess; required clues and duplicate letters retain existing rule validation. Saved privately and synchronized. |
| Encrypted Sync | Automatic by default for an Amber account. The toggle supports explicit pause/resume; compact status supports approval/retry or cancellation. Guest status is off until sign-in. A fresh account defaults on; private local saves remain intact while paused. |
| Login Nostr | Deliberately Amber-only. The key stays in Amber; only operation-specific permissions are requested. |
| My Profile | Native profile read/edit/image upload, public-key copy and stats repair/correction. |
| New Player | Choose another Amber account or sign out to the separate offline save. Existing account data remains retained and isolated. No generated private-key replacement. |
| Check my streak | Native current/best panels and played/won/win-rate summary. An expandable distribution retains the native full-history feature. |
| Keyboard / hardware keys | Six-row daily board, six guesses, dictionary and hard-mode validation, pop/reveal/shake and transient game toasts. |
| UTC countdown / rollover | Below the bounded board; new day resets the draft and refreshes the daily state. Cached public profile name appears below the countdown when available. |

## Result

| Web action | Native equivalent and privacy |
| --- | --- |
| Result heading, revealed word and four summary columns | Same result messages, purple word, played/win-percent/streak/max-streak and next-word countdown. |
| Discuss today’s game | Honest explanation of the existing web Amber chat limitation. No unsupported room access or substitute signer is fabricated. |
| Completion donation | Same periodic donation prompt; it leads to the native donation card. |
| Share | Explicit Android share sheet with the same `WORD5`, purple/orange/black emoji grid, hard-mode marker and URL. Guesses are absent. |
| Post to Nostr | Preview and informed confirmation, Amber kind 1 signature, existing web tags and relay acknowledgements. Only the public emoji result and summary statistics enter the relay event. |
| Score recording / publication linkage | Part of the confirmed post, or a separate explicit score action. The Word5 score-validation request contains today’s guesses; the public relay post never does. The same signed public event is sent to the publication endpoint after score recording. A failed linkage stays pending for explicit retry. |
| Retry score / restore history | Native choice explains private restore versus public score submission. Restored results without guesses can link an existing server completion but cannot invent missing guesses. |

Automatic encrypted backup never submits a public completion or publication event. The public relay transport rejects private backup, HTTP authentication and server-completion envelopes.

## Social and profile

| Web pathway | Native equivalent |
| --- | --- |
| Current-game players / last seven games | Existing current-game and recent-games APIs, explanatory table and retryable failure. |
| Global / My Follows | Verified public kind 1 events, profile/avatar/handle/time, media and real external links. |
| Follow overlay | Fresh kind 3 contact read, preserving existing contact tags/content, then explicit Amber signature and relay acknowledgement. |
| Duels | Followed Word5 participants, last-21-day points/game count/activity ranking and native comparison selection. |
| Head-to-head | Two avatar/score/trophy panels, caption and three-column matchup log. Absolute periods avoid display-puzzle rollover collisions. |
| Comparison Share | Explicit native PNG rendering and Blossom upload followed by the existing kind 1 challenge protocol (`word5duel`, `word5challenge`, 21-day window, scores, image metadata and both players). |
| Top Streaks | Aggregate API rows, public profiles/avatars and best-streak ranking. Rows are not incorrectly parsed as signed Nostr events. |
| Top Scores | 1/7/21-day controls, posted-only filter, scores and server provenance note. |
| Leagues | Image/name/member cards, Week/Daily navigation, seven-day winners, avatar score rows and member detail. |
| Create / edit league | Native name, description, selected image, mutual-contact search and npub add; ten members including creator; existing kind 30078 definition contract. |
| Leave league | Explicit signed leave request and local hide. A newer verified definition that includes the player removes the local hide. |
| Owner leave requests | Review verified current requests and explicitly apply member removals. Native does not silently sign public membership updates during a read. |
| My Profile | Latest verified kind 0 metadata, photo preview, name/about editing, image choice/clear and explicit save. Unrelated metadata is preserved. |
| Image upload | Primal Blossom, exact kind 24242 authorization, content hash and HTTPS descriptor checks. Upload occurs only on the explicit save/share action. |
| Repair streak | Request-bound signed server history is reconciled into the encrypted save; original native games remain. |
| Lower current / best | Validated explicit confirmation and signed kind 5555 correction; private correction overlay survives restore and deterministically merges. Played/won, immutable outcomes and distribution remain intact. Failed public publication exposes an explicit retry. |
| Copy public key | Real npub encoding and Android clipboard. Amber private keys are never displayed or copied. |

## Measurement and validation boundaries

Phone comparisons use equal content viewports after measured system/camera-cutout/navigation insets. Web geometry, computed fonts/palette and actual renders precede implementation. Raw screenshots, controlled fixture definitions, APK bytes/hashes and device evidence stay in ignored handoffs. Visual fixtures call the production native composables and are labelled; no fixture signing or public-write transport exists. Live read-only Social captures complement fixture views, and the release APK receives its own game, menu, result, profile and real Amber checks.

The inner encrypted save is version 2 with strict version-1 migration. Backend correction anchors are private signed-summary data; activating any new backend contract is a separate deployment decision. Source tests and local review do not claim production activation, store admission or approval to publish the APK.
