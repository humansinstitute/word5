# Word5 public reader API

An approved Nostr identity can read public player statistics, games and accepted results through `/api/public-reader/v1`. This API adds no chat, encrypted backup, private completion, guess, answer, raw-event or reconciliation-operator access. Existing app APIs remain available with their existing permissions.

## Authentication and instance setup

Use [NIP-98 HTTP authentication](https://github.com/nostr-protocol/nips/blob/master/98.md), checked against the official specification on 2026-11-18. Every route, including discovery, requires `Authorization: Nostr <base64 JSON signed event>`. The server validates signature, event hash, kind `27235`, the compiled approved public key, empty content, integer timestamp within ±60 seconds, and unique two-element `u` and `method` tags. An optional `wm-session-capability` tag is accepted for Wingman broker compatibility: exactly three nonempty string values, at most 1024 characters each. This tag is correlation metadata only; it grants no additional permission. Sign `GET` and the **exact externally visible absolute URL including the query string in its original order and encoding**. GET requests must have no body. Other additional tags, payload tags and duplicate tags are rejected by this narrow API. Synchronize your clock.

A token can be reused for the same URL during its short validity window. This read-only API does not claim single-use replay protection. Never publish auth events to relays or log Authorization headers.

The server reconstructs the external URL from a trusted configuration, never from Host, Forwarded or X-Forwarded headers. Set **one** canonical HTTPS base ending with `/` per instance:

| Instance | `WORD5_READER_PUBLIC_BASE` |
| --- | --- |
| Production | `https://otherstuff.ai/word5/` (default) |
| Development WApp | `https://late-bee-mill.rick.runwingman.com/` |

If unset, the reader uses `WORD5_PUBLIC_BASE`, then the production default. An invalid base fails startup. Configuration changes require the normal authorized activation of the server. The production reverse proxy must strip `/word5` before forwarding to Bun; Bun receives `/api/public-reader/v1/...`. The development WApp forwards that path directly. Preserve the complete original query and Authorization header. Do not permit caches to store authenticated responses. A development token is not valid on production, or vice versa.

`GET /api/health` exposes `publicReader.build` (`20261118-1`) and `publicReader.path` to identify the activated implementation. This marker is source evidence until the intended runtime has been activated and checked.

## Usage

Example using `nostr-tools` and an already authorized local signing key (or supply the same event template to your Nostr signer):

```ts
import { finalizeEvent } from 'nostr-tools';

const url = 'https://otherstuff.ai/word5/api/public-reader/v1/results?limit=50';
const event = finalizeEvent({
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  content: '',
  tags: [['u', url], ['method', 'GET']],
}, authorizedSecretKey); // Your signer; never send the secret to Word5.
const response = await fetch(url, {
  headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64') },
});
if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
const page = await response.json();
```

For browser clients, use UTF-8 JSON bytes with base64 encoding instead of Node's Buffer. There is no added cross-origin browser CORS grant. Server clients or same-origin clients can call the API.

Sign a fresh exact URL for every next-page request. Fetch discovery at the base API path (no trailing slash or query) to obtain datasets, projected fields and query rules.

## Datasets and fields

All dataset responses contain `schema`, `contract`, `visibility`, `dataset`, `fields`, `rows`, `total`, and `nextCursor`. `visibility` is always `public-only`; the calculation contract is `word5.calculation.v1`.

| GET path suffix | Explicit row fields | Optional filters |
| --- | --- | --- |
| `/players` | `pubkey`, `npub`, `played`, `won`, `streak`, `maxStreak` | `pubkey` |
| `/games` | `periodId`, `puzzle`, `date`, `games`, `wins`, `points` | `periodId` |
| `/results` | `pubkey`, `npub`, `periodId`, `puzzle`, `date`, `result`, `points`, `sourceEventId`, `source` | `pubkey`, `periodId` |

`pubkey` is lowercase 64-character hex; `npub` is its bech32 encoding. `periodId` is the nonnegative UTC day integer since the Unix epoch; `puzzle` is the cycling game number, not a unique key. Dates are UTC. Results are `1`–`6` or `X`; points are 10, 7, 5, 3, 2, 1 or 0 respectively.

Players include public-history identities, active reviewed lifetime-best identities effective by now, and identities with accepted published outcomes. Counts and streaks use the canonical public-only replay, including reviewed correction anchors and best-streak baselines. A baseline does not fabricate game rows or seed a current winning run. This is the complete player inventory, not the capped top-200 streak leaderboard; zero-streak players are included. `played` and `won` may include a reviewed historical correction baseline and therefore need not equal the available result count.

Games aggregate accepted **public** outcomes and include only days with such outcomes. Results contain one canonical outcome per player/day. Duplicates collapse; ambiguous conflicting legacy evidence is excluded until resolved. Published validated completions can appear; unpublished completions cannot. `sourceEventId` identifies public evidence, never the private completion event. `source` is canonical provenance. No raw signed event or event content is returned. Coverage reflects the server's public archive, not every game ever played or every relay event.

## Pagination and errors

Use `limit=1`–`200` (default 50). All integer parameters use plain nonnegative decimal notation. Unknown, empty, duplicate or invalid parameters return `400`. Players sort by public key; games by ascending period; results by ascending period then public key. Optional filters are exact matches, with an empty row list for no match.

Follow `nextCursor` until null. It is an opaque, bounded token tied to the dataset, filters and projected public rows; do not edit it. Page size can change. Public changes between requests return `409`; discard accumulated pages and restart without a cursor. The API does not retain a server snapshot. Private-only writes do not invalidate cursors. A forged cursor grants no additional fields or dataset access. Concurrent public updates can require repeated restarts; avoid assuming a fixed export during active ingestion.

Pagination bounds response size, not canonical calculation cost: each request currently computes the public projection to ensure consistency with existing calculations. Do not run unbounded concurrent exports.

| Status | Meaning |
| --- | --- |
| `200` | Discovery or public dataset page |
| `400` | Invalid parameters, cursor or body |
| `401` | Missing or invalid NIP-98 auth, wrong signer, URL, method or timestamp |
| `404` | Unknown dataset |
| `405` | Anything except GET; `Allow: GET` |
| `409` | Public data or cursor filters changed; restart pagination |
| `500` | Generic reader failure; no internal exception details returned |

All reader responses use `Cache-Control: no-store` and `Vary: Authorization`. No database writes, relay catch-up, publishing, chat pruning or signing occurs in the reader handler. Operator allowlists and backup/chat authorization remain separate.
