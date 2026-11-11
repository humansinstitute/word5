// NIP-55 browser transport. Never launch an external app without a button click.
(function () {
  const PENDING = 'word5-amber-pending-v1';
  const RETURNED = 'word5-amber-returned-v1';
  const PACKAGE = 'com.greenart7c3.nostrsigner';
  const VERSION = '20261111-6';
  let stage = 'ready', errorCode = 'none';
  const TTL = 15 * 60 * 1000;
  let waiter = null;
  let restoring = null;
  let cryptoPayload = null, cryptoResult = null, generation = 0;
  const CRYPTO_RESULT = 'word5-amber-crypto-result-v1';
  const isCrypto = r => ['nip44_encrypt', 'nip44_decrypt'].includes(r?.type);
  const resultLabel = r => r.type === 'get_public_key' ? 'public key' : r.type === 'sign_event' ? 'signed event' : r.type === 'nip44_encrypt' ? 'encrypted text' : 'decrypted text';
  const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
  const matches = (a, b) => a && b && a.type === b.type && a.pubkey === b.pubkey && a.peer === b.peer && a.inputHash === b.inputHash;
  function validCiphertext(value) {
    try { const bytes = atob(value); return value.length <= 90000 && bytes.length >= 99 && bytes.charCodeAt(0) === 2 && /^[A-Za-z0-9+/]+={0,2}$/.test(value); } catch (_) { return false; }
  }
  function persist(request) {
    // Encryption inputs and all decrypted outputs remain in memory only.
    const { payload, ...safe } = request;
    localStorage.setItem(PENDING, JSON.stringify(safe));
  }
  const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
  const identity = p => p?.linked_pubkey || p?.pubkey;
  const tools = () => import('https://esm.sh/nostr-tools@2?bundle');
  const unsigned = e => ({ pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content });
  const sameEvent = (a, b) => JSON.stringify(unsigned(a)) === JSON.stringify(unsigned(b));
  // Callers recreate timestamps on reload. A returned signature may satisfy the same
  // payload again, but never a different account, kind, content or tag set.
  const samePayload = (a, b) => sameEvent({ ...a, created_at: 0 }, { ...b, created_at: 0 });
  function fresh(r) { return r && Number.isFinite(r.at) && Date.now() - r.at >= 0 && Date.now() - r.at < TTL; }
  function clear() {
    localStorage.removeItem(PENDING); cryptoPayload = null;
    document.getElementById('amberRequest')?.remove();
  }
  function cancel() {
    generation++; clear();
    localStorage.removeItem(RETURNED);
    localStorage.removeItem(CRYPTO_RESULT); cryptoPayload = null; cryptoResult = null;
    stage = 'cancelled';
    if (waiter) { const error = new Error('Amber request cancelled. Retry when ready.'); error.code = 'AMBER_CANCELLED'; waiter.reject(error); waiter = null; }
  }
  function show(request, message = '') {
    document.getElementById('amberRequest')?.remove();
    const panel = document.createElement('div');
    panel.id = 'amberRequest';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Amber signer request');
    panel.style.cssText = 'position:fixed;inset:auto 12px 20px;z-index:2000;padding:18px;background:#1a1a1b;color:white;border:1px solid #9333ea;border-radius:12px;max-width:460px;margin:auto;';
    const text = document.createElement('p');
    text.textContent = message || (request.type === 'get_public_key' ? 'Connect the account in Amber that you use for Word5.' : `Approve ${resultLabel(request)} in Amber, then return here. Your key stays in Amber.`);
    const open = document.createElement('button');
    open.className = 'nostr-btn'; open.textContent = 'Open Amber';
    const active = () => {
      const current = window.NostrSession?.getPlayer();
      return fresh(request) && identity(current) === (request.type === 'get_public_key' ? request.previous : request.pubkey);
    };
    const launch = (manual) => {
      if (!active()) { cancel(); showError('Request expired or account changed. Retry the action.'); return; }
      const saved = read(PENDING);
      if (fresh(saved) && saved.id !== request.id) return;
      if (isCrypto(request) && !matches(cryptoPayload, request)) { text.textContent = 'Repeat the original action to resume this request, then open Amber.'; return; }
      request.manual = manual;
      persist(request);
      stage = manual ? 'copy-in-amber' : (request.type === 'get_public_key' ? 'waiting-public-key' : 'waiting-signature');
      errorCode = 'none';
      text.textContent = manual
        ? 'Approve in Amber to copy the result, then switch back to Word5 and paste it below.'
        : 'Waiting for Amber to return your ' + (resultLabel(request) + '.') + ' If you are back here without a result, choose Return result manually.';
      const callback = new URL(location.pathname, location.origin);
      callback.hash = `amber-state=${encodeURIComponent(request.id)}&amber-result=`;
      const extras = { type: request.type, ...(manual ? {} : { callbackUrl: callback.href }),
        returnType: request.type === 'sign_event' ? 'event' : 'signature', compression: 'none', appName: 'Word5',
        ...(request.pubkey ? { current_user: request.pubkey } : {}), ...(request.peer ? { pubkey: request.peer } : {}), id: request.id };
      // Keep the query-free transport: stable Amber decodes a whole web query
      // before splitting it, including punctuation embedded in event content.
      const payload = request.event ? encodeURIComponent(JSON.stringify(request.event).replace(/\?/g, '\\u003f')) : isCrypto(request) ? encodeURIComponent(cryptoPayload.payload) : '';
      const options = Object.entries(extras).map(([key, value]) => `S.${key}=${encodeURIComponent(value)};`).join('');
      location.href = `intent:${payload}#Intent;scheme=nostrsigner;package=${PACKAGE};${options}end`;
    };
    open.onclick = () => launch(false);
    const manual = document.createElement('button');
    manual.className = 'nostr-btn'; manual.textContent = 'Return result manually';
    const form = document.createElement('div'); form.hidden = !request.manual;
    const help = document.createElement('p');
    help.textContent = request.type === 'get_public_key'
      ? 'Open Amber in copy mode, approve, then return here. You can also copy your PUBLIC npub directly from your account screen in Amber. This selects your account; later actions still require signatures. Paste only your PUBLIC key (npub or 64-character hex). Never paste a secret key or recovery words.'
      : isCrypto(request) ? `Open Amber in copy mode, approve, then return here. Paste only the ${resultLabel(request)}, without JSON wrapping. Decrypted text is used only in this tab.` : 'Open Amber in copy mode, approve, then return here. Paste the complete signed event JSON. Never paste a secret key or recovery words.';
    const copy = document.createElement('button'); copy.className = 'nostr-btn'; copy.textContent = 'Open Amber in copy mode';
    copy.onclick = () => launch(true);
    const input = document.createElement('textarea'); input.id = 'amberManualResult';
    input.setAttribute('aria-label', `${resultLabel(request)} from Amber`);
    input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = isCrypto(request) ? 90000 : 24000;
    input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:8px 0;color:white;background:#272729;';
    const paste = document.createElement('button'); paste.className = 'nostr-btn'; paste.textContent = 'Paste from clipboard';
    paste.onclick = async () => {
      try { input.value = await navigator.clipboard.readText(); text.textContent = 'Result pasted. Tap Use result to validate it.'; }
      catch (_) { text.textContent = 'Clipboard access unavailable. Tap the text box and paste using your keyboard.'; input.focus(); }
    };
    const use = document.createElement('button'); use.className = 'nostr-btn'; use.textContent = 'Use result';
    use.onclick = async () => {
      if (use.disabled) return;
      if (!active() || read(PENDING)?.id !== request.id) { text.textContent = 'Request expired, cancelled or account changed. Start again.'; return; }
      use.disabled = true;
      const value = isCrypto(request) ? input.value : input.value.trim(); input.value = '';
      const player = window.NostrSession.getPlayer();
      const restored = await acceptResult(player, request, value, true);
      // acceptResult checks the request and identity again after asynchronous work.
      window.NostrSession.updatePlayer(restored);
      use.disabled = false;
    };
    manual.onclick = () => {
      if (!active()) { cancel(); showError('Request expired or account changed. Retry the action.'); return; }
      const saved = read(PENDING); if (fresh(saved) && saved.id !== request.id) return;
      request.manual = true; persist(request);
      form.hidden = false; stage = 'manual-entry'; text.textContent = 'Return the result manually using the steps below.';
    };
    form.append(help, copy, input, paste, use);
    const diagnostic = document.createElement('button'); diagnostic.className = 'nostr-btn'; diagnostic.textContent = 'Copy connection status';
    const diagnosticText = document.createElement('p');
    diagnostic.onclick = async () => {
      const status = `Word5 ${VERSION}; stage=${stage}; error=${errorCode}`;
      diagnosticText.textContent = status;
      try { await navigator.clipboard.writeText(status); } catch (_) { /* visible text is the fallback */ }
    };
    const close = document.createElement('button');
    close.className = 'nostr-btn'; close.textContent = 'Cancel'; close.onclick = cancel;
    panel.style.maxHeight = '85vh'; panel.style.overflowY = 'auto';
    panel.append(text, open, manual, form, diagnostic, diagnosticText, close); document.body.appendChild(panel);
  }
  function login() {
    cancel(); stage = 'ready'; errorCode = 'none';
    show({ id: crypto.randomUUID(), at: Date.now(), type: 'get_public_key', previous: identity(window.NostrSession?.getPlayer()) });
  }
  function restore(player) {
    if (restoring) return restoring;
    restoring = restoreReturn(player).finally(() => { restoring = null; });
    return restoring;
  }
  async function restoreReturn(player) {
    const cached = read(CRYPTO_RESULT);
    if (cached && (!fresh(cached) || cached.pubkey !== identity(player))) localStorage.removeItem(CRYPTO_RESULT);
    if (cryptoResult && (!fresh(cryptoResult) || cryptoResult.pubkey !== identity(player))) cryptoResult = null;
    if (cryptoPayload && (!fresh(cryptoPayload) || cryptoPayload.pubkey !== identity(player))) cryptoPayload = null;
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has('amber-result') && !params.has('amber-state')) {
      const pending = read(PENDING);
      if (fresh(pending)) {
        stage = pending.manual ? 'manual-entry' : (pending.type === 'get_public_key' ? 'waiting-public-key' : 'waiting-signature');
        show(pending, 'Amber has not delivered your ' + (resultLabel(pending) + '.') + ' Retry or choose Return result manually.');
      }
      else if (pending) clear();
      return player;
    }
    // Keep signatures and completion guesses out of HTTP requests, referrers and browser history.
    history.replaceState(null, '', location.pathname + location.search);
    const pending = read(PENDING);
    if (fresh(pending) && (params.get('amber-state') !== pending.id || !params.get('amber-result'))) {
      // A stale return or a bare callback must not destroy a recoverable request.
      errorCode = params.get('amber-state') !== pending.id ? 'unmatched-return' : 'missing-result';
      show(pending, 'Amber did not return a result for this request. Retry or choose Return result manually.');
      return player;
    }
    return acceptResult(player, pending, params.get('amber-result'), false);
  }
  async function acceptResult(player, pending, result, manual) {
    try {
      if (!fresh(pending)) throw new Error('Unrecognized or expired Amber return');
      if (identity(player) !== (pending.type === 'get_public_key' ? pending.previous : pending.pubkey)) throw new Error('Account changed during Amber request');
      if (typeof result !== 'string' || result.length > (isCrypto(pending) ? 90000 : 24000) || result === 'rejected' || result === 'true') throw new Error('Amber request cancelled or invalid');
      // Reject secret-looking input before importing or retaining any pasted text.
      if (!isCrypto(pending) && (result.startsWith('nsec') || result.split(/\s+/).length >= 12 && !result.startsWith('{'))) throw new Error('Paste only a public key or signed event, never a secret');
      stage = 'validating-result';
      const nt = await tools();
      // Import/verification can yield while Cancel, another request or an account
      // switch happens. A late callback must never overwrite that newer state.
      const current = window.NostrSession?.getPlayer() || player;
      if (read(PENDING)?.id !== pending.id) return current;
      if (!fresh(pending)) throw new Error('Unrecognized or expired Amber return');
      if (identity(current) !== identity(player)) {
        clear();
        if (waiter) { waiter.reject(new Error('Account changed during Amber request')); waiter = null; }
        showError('Account changed during Amber request');
        return current;
      }
      if (pending.type === 'get_public_key') {
        let pubkey = result;
        if (pubkey.startsWith('npub1')) { const decoded = nt.nip19.decode(pubkey); if (decoded.type !== 'npub') throw new Error('Invalid public key'); pubkey = decoded.data; }
        if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid Amber public key');
        clear(); stage = 'connected'; errorCode = 'none';
        showSuccess();
        return { ...player, auth_mode: 'amber', bunker_uri: null, linked_pubkey: pubkey,
          linked_npub: nt.nip19.npubEncode(pubkey), signer_package: PACKAGE, linked_at: Date.now() };
      }
      if (isCrypto(pending)) {
        if (pending.type === 'nip44_encrypt' && !validCiphertext(result)) throw new Error('Invalid NIP-44 v2 ciphertext');
        if (pending.type === 'nip44_decrypt' && (result === 'Could not decrypt the message' || result === '')) throw new Error('Amber could not decrypt this message');
        const returned = { ...pending, at: Date.now(), value: result };
        // Scalar output is not a signed event: only the consuming roundtrip/schema
        // can establish authenticity. Never persist decrypted output.
        if (pending.type === 'nip44_encrypt') localStorage.setItem(CRYPTO_RESULT, JSON.stringify(returned));
        else cryptoResult = returned;
        clear(); stage = 'crypto-result-received'; errorCode = 'none';
        if (waiter) {
          localStorage.removeItem(CRYPTO_RESULT); cryptoResult = null;
          const activeWaiter = waiter; waiter = null; activeWaiter.resolve(result);
        } else showError('Amber result received. Repeat the original action to continue');
        return player;
      }
      const event = JSON.parse(result);
      if (!sameEvent(event, pending.event) || event.pubkey !== pending.pubkey ||
          nt.getEventHash(event) !== event.id || !nt.verifyEvent(event)) throw new Error('Amber returned a different or invalid signed event');
      localStorage.setItem(RETURNED, JSON.stringify({ at: Date.now(), event }));
      clear(); stage = 'signature-received'; errorCode = 'none';
      if (!waiter && !event.tags.some(tag => tag[0] === 'schema' && tag[1] === 'word5.completion.v1')) {
        showError('Amber signature received. Repeat the action to continue with the approved signature');
      }
      if (waiter) { localStorage.removeItem(RETURNED); waiter.resolve(event); waiter = null; }
      return player;
    } catch (error) {
      // A failed asynchronous import must not cancel a newer request either.
      if (pending && read(PENDING)?.id !== pending.id) return window.NostrSession?.getPlayer() || player;
      errorCode = 'result-rejected'; stage = 'result-rejected';
      if (manual && fresh(pending) && identity(window.NostrSession?.getPlayer() || player) === (pending.type === 'get_public_key' ? pending.previous : pending.pubkey)) {
        show(pending, 'Result could not be accepted. Paste only the requested result; retry in Amber if needed.');
        return window.NostrSession?.getPlayer() || player;
      }
      clear();
      if (waiter) { waiter.reject(error); waiter = null; }
      showError(error.message || String(error));
      // Module loading may have failed after the user switched accounts.
      // Error reporting must retain the current player, just like success does.
      return window.NostrSession?.getPlayer() || player;
    }
  }
  function showSuccess() {
    const status = document.createElement('div');
    status.id = 'amberConnected'; status.setAttribute('role', 'status');
    status.style.cssText = 'position:fixed;bottom:20px;left:12px;right:12px;z-index:2000;background:#1a1a1b;color:white;padding:18px;';
    status.textContent = 'Connected with Amber. You’re ready to play.';
    document.getElementById(status.id)?.remove();
    document.body.appendChild(status);
    setTimeout(() => status.remove(), 5000);
  }
  function showError(message) {
    const panel = document.createElement('div'); panel.id = 'amberRequest';
    panel.style.cssText = 'position:fixed;bottom:20px;left:12px;right:12px;z-index:2000;background:#1a1a1b;color:white;padding:18px;';
    panel.textContent = `${message}. Your identity is kept. `;
    const close = document.createElement('button'); close.textContent = 'Dismiss'; close.onclick = () => panel.remove();
    panel.append(close); document.body.appendChild(panel);
  }
  async function signEvent(template) {
    const player = window.NostrSession.getPlayer();
    const pubkey = identity(player);
    if (player.auth_mode !== 'amber') throw new Error('Amber account is no longer active');
    const event = unsigned({ ...template, pubkey });
    const cached = read(RETURNED);
    if (fresh(cached) && samePayload(cached.event, event)) {
      const nt = await tools();
      if (nt.getEventHash(cached.event) === cached.event.id && nt.verifyEvent(cached.event)) {
        localStorage.removeItem(RETURNED); return cached.event;
      }
    }
    if (waiter) throw new Error('Finish or cancel the pending Amber request first');
    const pending = read(PENDING);
    const resume = fresh(pending) && pending.type === 'sign_event' && pending.pubkey === pubkey && samePayload(pending.event, event);
    if (fresh(pending) && !resume) throw new Error('Finish or cancel the pending Amber request first');
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      show(resume ? pending : { id: crypto.randomUUID(), at: Date.now(), type: 'sign_event', pubkey, event });
    });
  }
  async function cryptoRequest(type, peer, payload) {
    const player = window.NostrSession.getPlayer(), pubkey = identity(player);
    if (player.auth_mode !== 'amber') throw new Error('Amber account is no longer active');
    if (!/^[0-9a-f]{64}$/.test(peer) || typeof payload !== 'string' || !payload.length || new TextEncoder().encode(payload).length > 60000) throw new Error('Invalid Amber encryption request');
    // Stable Amber's browser parser splits decoded question marks as parameters.
    if (type === 'nip44_encrypt' && payload.includes('?')) throw new Error('This Amber browser transport cannot safely encrypt text containing a question mark');
    if (type === 'nip44_decrypt' && !validCiphertext(payload)) throw new Error('Invalid NIP-44 v2 ciphertext');
    const started = generation;
    const inputHash = await digest(payload);
    if (generation !== started) throw new Error("Amber request cancelled. Retry when ready.");
    if (identity(window.NostrSession.getPlayer()) !== pubkey || window.NostrSession.getPlayer().auth_mode !== 'amber') throw new Error('Account changed during Amber request');
    const request = { id: crypto.randomUUID(), at: Date.now(), type, pubkey, peer, inputHash };
    const cached = type === 'nip44_encrypt' ? read(CRYPTO_RESULT) : cryptoResult;
    if (fresh(cached) && matches(cached, request)) {
      localStorage.removeItem(CRYPTO_RESULT); cryptoResult = null;
      if (type === 'nip44_encrypt' && !validCiphertext(cached.value)) throw new Error('Invalid saved NIP-44 ciphertext');
      return cached.value;
    }
    if (cached && (!fresh(cached) || cached.pubkey !== pubkey)) { localStorage.removeItem(CRYPTO_RESULT); cryptoResult = null; }
    if (waiter) throw new Error('Finish or cancel the pending Amber request first');
    const pending = read(PENDING);
    const resume = fresh(pending) && matches(pending, request);
    if (fresh(pending) && !resume) throw new Error('Finish or cancel the pending Amber request first');
    const next = resume ? pending : request;
    cryptoPayload = { ...next, payload };
    return new Promise((resolve, reject) => { waiter = { resolve, reject }; show(next); });
  }
  // A callback may arrive in the existing tab. A new tab/reload resumes through ensurePlayer.
  async function resumeReturn() {
    if (!/(^#|&)amber-(state|result)=/.test(location.hash)) {
      const pending = read(PENDING);
      if (fresh(pending) && !pending.manual) {
        const text = document.getElementById('amberRequest')?.querySelector('p');
        if (text) text.textContent = 'Amber has not delivered your ' + (resultLabel(pending) + '.') + ' Retry or choose Return result manually.';
      }
      return;
    }
    const player = window.NostrSession?.getPlayer();
    if (player) { const restored = await restore(player); window.NostrSession.updatePlayer(restored); }
  }
  window.addEventListener('hashchange', resumeReturn);
  window.addEventListener('pageshow', resumeReturn);
  window.addEventListener('focus', resumeReturn);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeReturn(); });
  window.AmberSigner = { login, restore, signEvent, cancel, nip44Encrypt: (peer, text) => cryptoRequest('nip44_encrypt', peer, text), nip44Decrypt: (peer, text) => cryptoRequest('nip44_decrypt', peer, text) };
})();
