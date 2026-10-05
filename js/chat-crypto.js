(function (root) {
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const aad = (period, pubkey, nonce) => new TextEncoder().encode(`word5.chat.v1:${period}:${pubkey}:${nonce}`);
  const key = value => crypto.subtle.importKey('raw', decode(value), 'AES-GCM', false, ['encrypt', 'decrypt']);
  root.Word5ChatCrypto = {
    async encrypt(text, roomKey, period, pubkey, nonce) {
      const bytes = new TextEncoder().encode(text.trim());
      if (!bytes.length || bytes.length > 2000) throw new Error('Use 1–2000 UTF-8 bytes of text');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:aad(period,pubkey,nonce)}, await key(roomKey), bytes);
      return {iv:encode(iv), ciphertext:encode(ciphertext)};
    },
    async decrypt(body, roomKey, pubkey) {
      const bytes = await crypto.subtle.decrypt({name:'AES-GCM', iv:decode(body.iv), additionalData:aad(body.period,pubkey,body.nonce)}, await key(roomKey), decode(body.ciphertext));
      if (bytes.byteLength > 2000) throw new Error('Message too large');
      return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    },
    prune(storage, identity, now = Date.now()) {
      const prefix = 'word5-chat:';
      for (let i=storage.length-1;i>=0;i--) {
        const name = storage.key(i);
        if (!name?.startsWith(prefix)) continue;
        try {
          const value = JSON.parse(storage.getItem(name));
          if (!identity || name !== `${prefix}${identity}` || !Array.isArray(value)) { storage.removeItem(name); continue; }
          storage.setItem(name, JSON.stringify(value.filter(room => Number.isSafeInteger(room.period) && room.expiresAt === (room.period+3)*86400000 && room.expiresAt>now)));
        } catch { storage.removeItem(name); }
      }
    }
  };
})(globalThis);
