(function () {
  let identity = null, rooms = [], generation = 0, polling = false;
  const $ = id => document.getElementById(id);
  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  const signedIn = () => {
    const p = window.NostrSession?.getPlayer?.();
    return p && (p.auth_mode === 'nip07' || p.auth_mode === 'bunker' || (p.auth_mode === 'session' && p.imported_at));
  };
  const initialPlayer = window.NostrSession?.getPlayer?.();
  Word5ChatCrypto.prune(sessionStorage, signedIn() ? (initialPlayer.linked_pubkey || initialPlayer.pubkey) : null);
  async function request(action, fields = {}) {
    if (!signedIn()) throw new Error('Sign in with Nostr to discuss the game');
    const signer = await NostrSigners.getActiveSigner();
    const pubkey = await signer.getPublicKey();
    if (pubkey !== identity) throw new Error('Identity changed; reopen chat');
    const event = await signer.signEvent({kind:30078, created_at:Math.floor(Date.now()/1000), tags:[['schema','word5.chat.v1']], content:JSON.stringify({action,nonce:nonce(),...fields})});
    if (event.pubkey !== identity) throw new Error('Signer identity mismatch');
    const response = await fetch(`api/chat/${action}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event})});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Chat unavailable');
    return result;
  }
  function prune() {
    Word5ChatCrypto.prune(sessionStorage, identity);
    rooms = rooms.filter(room=>room.expiresAt>Date.now());
    const nav = $('chatNav');
    if (nav) nav.hidden = !rooms.length;
  }
  async function refresh() {
    const run = ++generation;
    rooms = [];
    if ($('chatNav')) $('chatNav').hidden=true;
    renderRooms();
    if (!signedIn()) { identity = null; prune(); if ($('chatStatus')) $('chatStatus').textContent = 'Sign in with Nostr, then finish a daily puzzle to unlock chat.'; return; }
    try {
      const signer = await NostrSigners.getActiveSigner();
      const pk = await signer.getPublicKey();
      if (run !== generation) return;
      identity = pk;
      Word5ChatCrypto.prune(sessionStorage, identity);
      const result = await request('rooms');
      if (run !== generation || !signedIn()) return;
      rooms = result.rooms;
      sessionStorage.setItem(`word5-chat:${identity}`,JSON.stringify(rooms));
      prune(); renderRooms();
      if ($('chatStatus')) $('chatStatus').textContent = rooms.length ? '' : 'Finish a daily puzzle to unlock its room.';
      await read();
    } catch (error) { if (run===generation && $('chatStatus')) $('chatStatus').textContent = error.message; }
  }
  function renderRooms() {
    const select = $('chatRoom');
    if (!select) return;
    const selected = select.value;
    select.replaceChildren();
    for (const room of rooms) {
      const option = document.createElement('option'); option.value=String(room.period); option.textContent=`Puzzle ${room.date} · UTC`; select.append(option);
    }
    if (rooms.some(room=>String(room.period)===selected)) select.value=selected;
    $('chatSend').disabled=!rooms.length;
    updateCountdown();
    if (!rooms.length) { $('chatMessages').replaceChildren(); $('chatExpiry').textContent=''; }
  }
  const selectedRoom = () => rooms.find(room=>String(room.period)===$('chatRoom')?.value);
  function updateCountdown() {
    const room=selectedRoom();
    if(room) { const seconds=Math.max(0,Math.ceil((room.expiresAt-Date.now())/1000)); $('chatExpiry').textContent=`Expires in ${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m ${seconds%60}s · ${new Date(room.expiresAt).toISOString().replace('.000Z',' UTC')}`; }
  }
  async function read() {
    const room = selectedRoom(), run = generation;
    if (!room || polling) return;
    polling = true;
    try {
      const result = await request('read',{period:room.period});
      const {verifyEvent,getEventHash} = await import('https://esm.sh/nostr-tools@2?bundle');
      const nodes = [];
      for (const event of result.messages) {
        try {
          if (!verifyEvent(event) || getEventHash(event)!==event.id || event.kind!==30078 || event.tags.length!==1 || event.tags[0].join(':')!=='schema:word5.chat.v1') continue;
          const body = JSON.parse(event.content);
          if (body.period!==room.period || body.action!=='send') continue;
          const text = await Word5ChatCrypto.decrypt(body,room.key,event.pubkey);
          const item = document.createElement('li');
          const sender = document.createElement('small'); sender.textContent=`${event.pubkey.slice(0,12)}… · ${new Date(event.created_at*1000).toLocaleTimeString()}`; sender.title=event.pubkey;
          const message=document.createElement('p'); message.textContent=text;
          item.append(sender,message); nodes.push(item);
        } catch { /* Ignore malformed or unauthentic ciphertext. */ }
      }
      if (run===generation && selectedRoom()===room && room.expiresAt>Date.now()) $('chatMessages').replaceChildren(...nodes);
    } catch(error) { if (run===generation) $('chatStatus').textContent=error.message; }
    finally { polling=false; }
  }
  async function discuss() {
    if (!signedIn()) { $('loginNostrBtn')?.click(); return; }
    await window.Word5App?.recordCompletedScore?.();
    await refresh();
    if (rooms.length) location.href='chat.html';
  }
  window.Word5Chat={refresh,discuss};
  window.addEventListener('player-ready',()=>{
    const p=window.NostrSession?.getPlayer?.();
    const nextIdentity=signedIn() ? (p.linked_pubkey || p.pubkey) : null;
    generation++; identity=null; rooms=[];
    Word5ChatCrypto.prune(sessionStorage,nextIdentity);
    renderRooms(); void refresh();
  });
  window.addEventListener('word5-completed',()=>void refresh());
  document.addEventListener('DOMContentLoaded',async()=>{
    await NostrSigners.ready();
    $('discussGame')?.addEventListener('click',discuss);
    $('chatLogin')?.addEventListener('click',()=>$('loginNostrBtn')?.click());
    $('chatRoom')?.addEventListener('change',()=>{ $('chatMessages').replaceChildren(); updateCountdown(); void read(); });
    $('chatForm')?.addEventListener('submit',async event=>{
      event.preventDefault(); const room=selectedRoom(), run=generation;
      if (!room || room.expiresAt<=Date.now()) return;
      $('chatSend').disabled=true;
      try {
        // Encryption AAD uses the same nonce as the signed request.
        const messageNonce=nonce();
        const payload=await Word5ChatCrypto.encrypt($('chatText').value,room.key,room.period,identity,messageNonce);
        await request('send',{period:room.period,nonce:messageNonce,...payload});
        if(run===generation) { $('chatText').value=''; $('chatStatus').textContent=''; await read(); }
      } catch(error) { if(run===generation) $('chatStatus').textContent=error.message; }
      finally { if(run===generation) $('chatSend').disabled=!selectedRoom(); }
    });
    await refresh();
    setInterval(()=>{
      const before=rooms.length; prune(); if(before!==rooms.length) renderRooms();
      updateCountdown();
    },1000);
    if ($('chatMessages')) setInterval(()=>void read(),10000);
  });
})();
