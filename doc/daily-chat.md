# Daily post-game chat

Nostr sign-in and a server-verified private completion unlock a puzzle's room, for wins and exhausted guesses alike. Public score posts alone do not qualify. The existing completion validator recomputes outcomes from signed ordered guesses; this is casual spoiler protection, not proof that someone played without assistance.

The browser calls same-origin `POST api/chat/rooms`, `read`, and `send`. These requests are signed kind 30078 events with the sole schema tag `word5.chat.v1`, a matching action, and a random 128-bit nonce. Nothing is published to Nostr relays. `rooms` retrieves keys for the authenticated player's unexpired verified completions, including previous days. Identity changes clear cached keys and displayed messages.

Each UTC puzzle period has one random 256-bit AES-GCM key, separate from Nostr identity keys. Browser encryption uses a fresh 96-bit IV and authenticates the schema, period, sender public key, and nonce as additional data. The server stores signed ciphertext events. Readers verify the sender signature and event hash before decryption and render text through `textContent`.

Keys are stored in browser sessionStorage under the signing identity. The server retains its shared key in SQLite; it can decrypt messages, and recipients can share their key or retain copies. This is the accepted casual privacy boundary. Do not describe it as encryption that hides content from the server.

Rooms expire exactly at `(period + 3) * PERIOD_MS`, 00:00 UTC three days after the puzzle date (08:00 Perth). Startup and every chat API access delete expired rooms and messages. Completion records remain score history, but cannot recreate expired rooms. Browser startup, identity changes, and a one-second timer remove expired keys and room UI.

Limits: 200 messages per room, 2000 UTF-8 plaintext bytes in the browser, 4096 ciphertext base64 characters, 8000 request bytes read with a bounded stream, 40 signed requests per identity per minute, and 10 sends per minute with at least two seconds between sends. Signatures must be within 60 seconds; accepted request IDs are retained for 120 seconds to reject replay across restarts. Rate records contain no keys, message plaintext, or membership. Polling reads every ten seconds requires the signer to approve requests; extensions with per-signature prompts may be noisy.

Run `bun run test` for isolated database eligibility, authenticity, replay, encryption, expiry, storage cleanup and existing regressions. `test/browser-chat.smoke.ts` is an optional browser integration harness; pass `WORD5_PLAYWRIGHT_MODULE` pointing to an installed Playwright module. It uses a temporary database and in-memory test identities, without altering the managed app's player data.
