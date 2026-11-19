(function (root) {
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const aad = (period, pubkey, nonce, version=1) => new TextEncoder().encode(`word5.chat.v${version}:${period}:${pubkey}:${nonce}`);
  const key = value => crypto.subtle.importKey('raw', decode(value), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const validText = text => typeof text==='string' && text.trim().length>0 && new TextEncoder().encode(text).length<=2000;
  function action(value) {
    if(!value || value.v!==2 || typeof value.target!=='string' || !/^[0-9a-f]{64}$/.test(value.target))throw Error('Invalid chat action');
    const keys=Object.keys(value).sort().join(',');
    if(value.type==='reply' && keys==='target,text,type,v' && validText(value.text))return value;
    if(value.type==='like' && keys==='active,revision,target,type,v' && typeof value.active==='boolean' && Number.isSafeInteger(value.revision) && value.revision>0)return value;
    throw Error('Unsupported chat action');
  }
  root.Word5ChatCrypto = {
    action,
    // Input must already be verified, decrypted and bound to the selected room.
    reactions(records,target,actor) {
      const latest=new Map();
      for(const r of records) {
        const p=r.payload;if(p?.type!=='like'||p.target!==target)continue;
        const old=latest.get(r.event.pubkey);
        if(!old||p.revision>old.payload.revision||(p.revision===old.payload.revision&&r.event.id>old.event.id))latest.set(r.event.pubkey,r);
      }
      return {count:[...latest.values()].filter(r=>r.payload.active).length,own:latest.get(actor)?.payload.active===true,revision:latest.get(actor)?.payload.revision||0};
    },
    async encrypt(text, roomKey, period, pubkey, nonce) {
      const version=typeof text==='string'?1:2;
      if(version===2)action(text);
      const bytes = new TextEncoder().encode(version===1?text.trim():JSON.stringify(text));
      if (!bytes.length || bytes.length > (version===1?2000:3000)) throw new Error('Use 1–2000 UTF-8 bytes of text');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:aad(period,pubkey,nonce,version)}, await key(roomKey), bytes);
      return {iv:encode(iv), ciphertext:encode(ciphertext)};
    },
    async decrypt(body, roomKey, pubkey) {
      if(Object.keys(body).sort().join(',')!=='action,ciphertext,iv,nonce,period'||body.action!=='send'||!Number.isSafeInteger(body.period)||!/^[0-9a-f]{32}$/.test(body.nonce)||typeof body.iv!=='string'||!/^[A-Za-z0-9+/]{16}$/.test(body.iv)||typeof body.ciphertext!=='string'||body.ciphertext.length>4096||body.ciphertext.length<24||body.ciphertext.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.ciphertext))throw Error('Invalid encrypted message');
      const imported=await key(roomKey),ciphertext=decode(body.ciphertext),iv=decode(body.iv);
      let bytes;
      try { bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(body.period,pubkey,body.nonce)},imported,ciphertext); }
      catch {
        bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(body.period,pubkey,body.nonce,2)},imported,ciphertext);
        if(bytes.byteLength>3000)throw Error('Message too large');
        return action(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
      }
      if(!bytes.byteLength||bytes.byteLength>2000)throw Error('Message too large');
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    },
    prune(storage, identity, now = Date.now()) {
      const current=Math.floor(now/86400000);
      const validPeriod=p=>Number.isSafeInteger(p)&&(p===current||p===current-1);
      for(let i=storage.length-1;i>=0;i--) {
        const name=storage.key(i);
        if(name?.startsWith('word5-chat-messages:')) {
          try {
            const value=JSON.parse(storage.getItem(name));
            if(!identity||name!==`word5-chat-messages:${identity}:${value?.period}`||!validPeriod(value?.period)||value.expiresAt!==(value.period+2)*86400000||!Array.isArray(value.events)||value.events.length>200)storage.removeItem(name);
          } catch { storage.removeItem(name); }
        } else if(name?.startsWith('word5-chat:')) {
          try {
            const value=JSON.parse(storage.getItem(name));
            if(!identity||name!==`word5-chat:${identity}`||!Array.isArray(value)){storage.removeItem(name);continue;}
            storage.setItem(name,JSON.stringify(value.filter(room=>validPeriod(room.period)&&room.expiresAt===(room.period+2)*86400000&&room.expiresAt>now)));
          } catch {storage.removeItem(name);}
        } else if(name?.startsWith('word5-chat-pending:')) {
          try { const value=JSON.parse(storage.getItem(name));if(!identity||value.pubkey!==identity||!validPeriod(value.period)||name!==`word5-chat-pending:${identity}:${value.period}`)storage.removeItem(name); }
          catch {storage.removeItem(name);}
        } else if(name?.startsWith('word5-chat-selection:')&&(!identity||name!==`word5-chat-selection:${identity}`))storage.removeItem(name);
      }
    }
  };
})(globalThis);
