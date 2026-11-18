# Word5

Word5 is a Nostr word game. Play at [otherstuff.ai/word5](https://otherstuff.ai/word5/).

## Read public game data with an AI agent

The production API provides public player npubs, current streaks, best streaks, game totals and accepted published results. It grants no chat, encrypted backup, private completion, guess, answer or write access. Existing public app endpoints retain their existing permissions.

Production discovery URL:

```text
https://otherstuff.ai/word5/api/public-reader/v1
```

The currently approved reader identity is:

```text
npub1ueczxknr46czqs6wx7t8mnug2pwuhragqvchhunrxvh53ufmw0xq3r7j32
```

### Agent setup

1. Use a Nostr signer that controls the approved identity. Use its existing signing broker, hardware signer or other authorized signer. Do not generate a replacement identity, export its private key or send a secret to Word5. Confirm the signer's public key matches the approved npub. Other identities receive HTTP 401; request an explicit reader grant from the operator if needed.
2. Sign a NIP-98 kind `27235` event with empty content, the current Unix timestamp in seconds, and tags `['u', exactUrl]` and `['method', 'GET']`. The timestamp must be within 60 seconds of server time. `exactUrl` includes the complete query string, in the same order and encoding as the HTTP request. Send a bodyless GET with `Authorization: Nostr <base64-encoded signed event JSON>`. Do not publish auth events to relays or log auth headers.
3. Fetch discovery, then use its dataset routes: `/players` for counts and current/best streaks, `/games` for daily aggregates, and `/results` for individual public results. All routes below are appended to the discovery URL.
4. Page with `limit=1`–`200` (default 50). If a response has `nextCursor`, add that exact value as the next request's `cursor` query parameter, preserve your filters, and sign the resulting URL. Continue until `nextCursor` is null. On HTTP 409, discard the partial export and restart; public data changed between pages. Avoid concurrent export loops.
5. Optional filters: `pubkey=<lowercase hex key>` for players/results; `periodId=<UTC day integer since Unix epoch>` for games/results. Returned rows include npubs. Results are `1`–`6` or `X`. Player totals may include reviewed historical baselines, so they can differ from the number of archived result rows.

The following Bun/Node helper accepts your existing signer's `signEvent` function. If your broker already returns a complete NIP-98 Authorization header, use that header directly instead. Keep the configured URL fixed to production.

```ts
import { getEventHash, nip19, verifyEvent, type Event } from 'nostr-tools';

const api = 'https://otherstuff.ai/word5/api/public-reader/v1';
const approved = nip19.decode(
  'npub1ueczxknr46czqs6wx7t8mnug2pwuhragqvchhunrxvh53ufmw0xq3r7j32'
).data;
type SignEvent = (event: {
  kind: number; created_at: number; content: string; tags: string[][];
}) => Promise<Event>;

async function readWord5(url: string, signEvent: SignEvent) {
  const target = new URL(url);
  if (target.origin !== new URL(api).origin ||
      !(target.pathname === new URL(api).pathname ||
        target.pathname.startsWith(new URL(api).pathname + '/')) ||
      target.username || target.password || target.hash) {
    throw new Error('Unexpected Word5 API URL');
  }
  const template = {
    kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
    tags: [['u', url], ['method', 'GET']],
  };
  const event = await signEvent(template);
  if (event.pubkey !== approved || !verifyEvent(event) ||
      getEventHash(event) !== event.id || event.kind !== template.kind ||
      event.created_at !== template.created_at || event.content !== '' ||
      !event.tags.some(t => t.length === 2 && t[0] === 'u' && t[1] === url) ||
      !event.tags.some(t => t.length === 2 && t[0] === 'method' && t[1] === 'GET')) {
    throw new Error('Signer returned an invalid or unexpected authorization');
  }
  const response = await fetch(url, {
    redirect: 'error',
    headers: { Authorization: 'Nostr ' +
      Buffer.from(JSON.stringify(event), 'utf8').toString('base64') },
  });
  if (!response.ok) {
    throw new Error(`Word5 ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// Supply your signer's existing signEvent implementation:
// const discovery = await readWord5(api, signEvent);
// const firstPage = await readWord5(api + '/results?limit=50', signEvent);
// For each nextCursor, construct the URL first, then sign that exact URL:
// const next = new URL(api + '/results');
// next.searchParams.set('limit', '50');
// next.searchParams.set('cursor', firstPage.nextCursor);
// const nextPage = await readWord5(next.href, signEvent);
```

HTTP 401 means missing/invalid authorization, wrong identity, clock skew or URL/method mismatch. HTTP 400 means invalid query/body; 405 rejects writes; 409 means restart pagination. Browser integrations need same-origin access; the reader adds no cross-origin CORS grant. Successful access from the approved signer should be confirmed against production. Health is available at [the production health endpoint](https://otherstuff.ai/word5/api/health); the reader build is `20261118-1`.

See [the full API contract](doc/public-reader-api.md) for response fields, provenance, pagination and limitations. [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) defines the authentication format.

## Run the game server

Requires Bun. From this repository:

```sh
bun install --frozen-lockfile
bun run test
bun run start
```

The server defaults to port 41005 and `data/word5.sqlite`; configure `PORT` and `WORD5_DB_PATH` for your instance. `WORD5_READER_PUBLIC_BASE` must be the instance's canonical HTTPS base ending in `/`; production defaults to `https://otherstuff.ai/word5/`. It falls back to `WORD5_PUBLIC_BASE` when set. Private instance addresses belong in private configuration. Auth uses this configured base and ignores untrusted proxy headers. A production proxy strips `/word5` while preserving the query and Authorization header. Configure server publishing separately; reader clients never need the server's signing key.

Production builds from the `deployed` branch. Validate and commit on `main`, push it, then fast-forward `deployed` from `main`, push `deployed`, return to `main`, and verify the live health and API behavior. Preserve the persistent database. Deploy only with the operator's authorization.
