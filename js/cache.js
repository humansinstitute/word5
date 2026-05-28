// IndexedDB cache layer for Word5
// Shared infrastructure — leagues first, extensible to other tabs.
(function () {
  const DB_NAME = "word5-cache";
  const DB_VERSION = 1;
  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const d = e.target.result;

        if (!d.objectStoreNames.contains("leagues")) {
          const ls = d.createObjectStore("leagues", { keyPath: "eventId" });
          ls.createIndex("byCreator", "creator", { unique: false });
          ls.createIndex("byMember", "members", { unique: false, multiEntry: true });
          ls.createIndex("byDTag", "dTag", { unique: false });
        }

        if (!d.objectStoreNames.contains("scores")) {
          const ss = d.createObjectStore("scores", { keyPath: "eventId" });
          ss.createIndex("byPubkey", "pubkey", { unique: false });
          ss.createIndex("byCreatedAt", "createdAt", { unique: false });
        }

        if (!d.objectStoreNames.contains("profiles")) {
          const ps = d.createObjectStore("profiles", { keyPath: "pubkey" });
          ps.createIndex("byUpdatedAt", "updatedAt", { unique: false });
        }

        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta", { keyPath: "key" });
        }
      };

      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };

      req.onerror = (e) => reject(e.target.error);
    });
  }

  function tx(storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Leagues ---

  async function putLeague(league) {
    await openDB();
    return promisify(tx("leagues", "readwrite").put(league));
  }

  async function getLeaguesForUser(pubkey) {
    await openDB();
    const byCreator = await promisify(
      tx("leagues", "readonly").index("byCreator").getAll(pubkey)
    );
    const byMember = await promisify(
      tx("leagues", "readonly").index("byMember").getAll(pubkey)
    );
    // Deduplicate by dTag+creator, keeping the latest event
    const bestByKey = new Map();
    for (const l of [...byCreator, ...byMember]) {
      const key = `${l.dTag}:${l.creator}`;
      const existing = bestByKey.get(key);
      if (!existing || l.createdAt > existing.createdAt) {
        bestByKey.set(key, l);
      }
    }
    return Array.from(bestByKey.values());
  }

  async function getLeague(dTag, author) {
    await openDB();
    const all = await promisify(
      tx("leagues", "readonly").index("byDTag").getAll(dTag)
    );
    // Return the latest event for this dTag+author pair
    let best = null;
    for (const l of all) {
      if (l.creator !== author) continue;
      if (!best || l.createdAt > best.createdAt) best = l;
    }
    return best;
  }

  // --- Scores ---

  async function putScores(scores) {
    await openDB();
    const transaction = db.transaction("scores", "readwrite");
    const store = transaction.objectStore("scores");
    for (const s of scores) {
      store.put(s);
    }
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function getScoresForWindow(pubkeys, start, end) {
    await openDB();
    const results = [];
    const store = tx("scores", "readonly");
    const all = await promisify(store.index("byCreatedAt").getAll());
    const pkSet = new Set(pubkeys);
    for (const s of all) {
      if (pkSet.has(s.pubkey) && s.createdAt >= start && s.createdAt <= end) {
        results.push(s);
      }
    }
    return results;
  }

  // --- Profiles ---

  async function putProfile(profile) {
    await openDB();
    return promisify(tx("profiles", "readwrite").put(profile));
  }

  async function getProfile(pubkey) {
    await openDB();
    return promisify(tx("profiles", "readonly").get(pubkey));
  }

  // --- Meta ---

  async function getMeta(key) {
    await openDB();
    return promisify(tx("meta", "readonly").get(key));
  }

  async function setMeta(key, value) {
    await openDB();
    return promisify(tx("meta", "readwrite").put({ key, value }));
  }

  window.Word5Cache = {
    open: openDB,
    putLeague,
    getLeaguesForUser,
    getLeague,
    putScores,
    getScoresForWindow,
    putProfile,
    getProfile,
    getMeta,
    setMeta,
  };
})();
