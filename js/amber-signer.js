// NIP-55 browser transport. Never launch an external app without a button click.
(function () {
  const PENDING = 'word5-amber-pending-v1';
  const RETURNED = 'word5-amber-returned-v1';
  const PACKAGE = 'com.greenart7c3.nostrsigner';
  const TTL = 15 * 60 * 1000;
  let waiter = null;
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
    localStorage.removeItem(PENDING);
    document.getElementById('amberRequest')?.remove();
  }
  function cancel() {
    clear();
    if (waiter) { waiter.reject(new Error('Amber request cancelled. Retry when ready.')); waiter = null; }
  }
  function show(request, message = '') {
    document.getElementById('amberRequest')?.remove();
    const panel = document.createElement('div');
    panel.id = 'amberRequest';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Amber signer request');
    panel.style.cssText = 'position:fixed;inset:auto 12px 20px;z-index:2000;padding:18px;background:#1a1a1b;color:white;border:1px solid #9333ea;border-radius:12px;max-width:460px;margin:auto;';
    const text = document.createElement('p');
    text.textContent = message || (request.type === 'get_public_key' ? 'Connect the account in Amber that you use for Word5.' : 'Approve this signature in Amber, then return here. Your key stays in Amber.');
    const open = document.createElement('button');
    open.className = 'nostr-btn'; open.textContent = 'Open Amber';
    open.onclick = () => {
      const current = window.NostrSession?.getPlayer();
      if (!fresh(request) || (request.type !== 'get_public_key' && identity(current) !== request.pubkey)) {
        cancel(); text.textContent = 'Request expired or account changed. Retry the action.'; return;
      }
      // Persist only when the user actually launches. Cancel/retry never opens Amber automatically.
      localStorage.setItem(PENDING, JSON.stringify(request));
      const callback = new URL(location.pathname, location.origin);
      callback.hash = `amber-state=${encodeURIComponent(request.id)}&amber-result=`;
      const query = new URLSearchParams({ type: request.type, callbackUrl: callback.href,
        returnType: request.type === 'sign_event' ? 'event' : 'signature', compressionType: 'none', appName: 'Word5' });
      const payload = request.event ? encodeURIComponent(JSON.stringify(request.event)) : '';
      const account = request.pubkey ? `S.current_user=${encodeURIComponent(request.pubkey)};` : '';
      location.href = `intent:${payload}?${query}#Intent;scheme=nostrsigner;package=${PACKAGE};${account}end`;
      text.textContent = 'Waiting for Amber. If you cancelled or returned without approval, tap Open Amber to retry or Cancel.';
    };
    const close = document.createElement('button');
    close.className = 'nostr-btn'; close.textContent = 'Cancel'; close.onclick = cancel;
    panel.append(text, open, close); document.body.appendChild(panel);
  }
  function login() {
    cancel();
    show({ id: crypto.randomUUID(), at: Date.now(), type: 'get_public_key', previous: identity(window.NostrSession?.getPlayer()) });
  }
  async function restore(player) {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has('amber-result') && !params.has('amber-state')) {
      const pending = read(PENDING);
      if (fresh(pending)) show(pending, 'An Amber request is unfinished. Open Amber to retry or Cancel.');
      else if (pending) clear();
      return player;
    }
    // Keep signatures and completion guesses out of HTTP requests, referrers and browser history.
    history.replaceState(null, '', location.pathname + location.search);
    const pending = read(PENDING);
    try {
      if (!fresh(pending) || params.get('amber-state') !== pending.id) throw new Error('Unrecognized or expired Amber return');
      if (identity(player) !== (pending.type === 'get_public_key' ? pending.previous : pending.pubkey)) throw new Error('Account changed during Amber request');
      const result = params.get('amber-result');
      if (!result || result.length > 24000 || result === 'rejected' || result === 'true') throw new Error('Amber request cancelled or invalid');
      const nt = await tools();
      if (pending.type === 'get_public_key') {
        let pubkey = result;
        if (pubkey.startsWith('npub1')) { const decoded = nt.nip19.decode(pubkey); if (decoded.type !== 'npub') throw new Error('Invalid public key'); pubkey = decoded.data; }
        if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid Amber public key');
        clear();
        return { ...player, auth_mode: 'amber', bunker_uri: null, linked_pubkey: pubkey,
          linked_npub: nt.nip19.npubEncode(pubkey), signer_package: PACKAGE, linked_at: Date.now() };
      }
      const event = JSON.parse(result);
      if (!sameEvent(event, pending.event) || event.pubkey !== pending.pubkey ||
          nt.getEventHash(event) !== event.id || !nt.verifyEvent(event)) throw new Error('Amber returned a different or invalid signed event');
      localStorage.setItem(RETURNED, JSON.stringify({ at: Date.now(), event }));
      clear();
      if (!waiter && !event.tags.some(tag => tag[0] === 'schema' && tag[1] === 'word5.completion.v1')) {
        showError('Amber signature received. Repeat the action to continue with the approved signature');
      }
      if (waiter) { localStorage.removeItem(RETURNED); waiter.resolve(event); waiter = null; }
      return player;
    } catch (error) {
      clear();
      if (waiter) { waiter.reject(error); waiter = null; }
      showError(error.message || String(error));
      return player;
    }
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
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      show({ id: crypto.randomUUID(), at: Date.now(), type: 'sign_event', pubkey, event });
    });
  }
  // A callback may arrive in the existing tab. A new tab/reload resumes through ensurePlayer.
  window.addEventListener('hashchange', async () => {
    const player = window.NostrSession?.getPlayer();
    if (player) { const restored = await restore(player); window.NostrSession.updatePlayer(restored); }
  });
  window.AmberSigner = { login, restore, signEvent, cancel };
})();
