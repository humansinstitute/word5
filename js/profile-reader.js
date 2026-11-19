// Public, read-only profiles. One bounded queue and timer for every visible consumer.
(function () {
  const entries = new Map();
  let timer = null,
    running = 0,
    suspended = false;
  const queue = [];
  const safeUrl = (value) => {
    try {
      const u = new URL(value);
      return ["https:", "http:"].includes(u.protocol) &&
        !u.username &&
        !u.password
        ? u.href
        : "";
    } catch {
      return "";
    }
  };
  function entry(pk) {
    if (!entries.has(pk)) {
      if (entries.size >= 512) {
        const old = [...entries].find(
          ([, e]) => !e.listeners.size && !e.pending,
        );
        if (old) entries.delete(old[0]);
      }
      entries.set(pk, {
        profile: null,
        status: "idle",
        due: 0,
        failures: 0,
        revision: 0,
        listeners: new Set(),
        pending: null,
      });
    }
    return entries.get(pk);
  }
  function notify(e) {
    for (const fn of e.listeners)
      try {
        fn({ profile: e.profile, status: e.status, due: e.due });
      } catch {}
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (suspended) return;
    let due = Infinity;
    for (const e of entries.values())
      if (e.listeners.size && !e.pending) due = Math.min(due, e.due);
    if (Number.isFinite(due))
      timer = setTimeout(tick, Math.max(100, due - Date.now()));
  }
  function tick() {
    timer = null;
    for (const [pk, e] of entries)
      if (e.listeners.size && !e.pending && e.due <= Date.now())
        void load(pk, { observed: true });
    schedule();
  }
  function drain() {
    while (running < 3 && queue.length) {
      running++;
      const job = queue.shift();
      void job().finally(() => {
        running--;
        drain();
      });
    }
  }
  function load(pk, options = {}) {
    if (!/^[0-9a-f]{64}$/.test(pk || "")) return Promise.resolve(null);
    const e = entry(pk);
    if (e.pending) return e.pending;
    // Force can refresh a successful value, but cannot bypass failure/negative cooldowns.
    if (e.due > Date.now() && (!options.force || e.status !== "ready"))
      return Promise.resolve(e.profile);
    const revision = e.revision;
    e.status = "loading";
    notify(e);
    e.pending = new Promise((resolve) =>
      queue.push(async () => {
        try {
          if (options.observed && !e.listeners.size) return;
          if (navigator.onLine === false) throw new Error("Offline");
          const profile = await window.Word5Profiles.fetch(pk);
          if (e.revision !== revision) return;
          if (profile) e.profile = profile;
          e.status = profile ? "ready" : "missing";
          e.failures = 0;
          e.due = Date.now() + (profile ? 15 * 60 * 1000 : 5 * 60 * 1000);
        } catch {
          if (e.revision !== revision) return;
          e.status = navigator.onLine === false ? "offline" : "error";
          e.failures++;
          e.due =
            Date.now() +
            Math.min(300000, 5000 * 2 ** Math.min(6, e.failures - 1)) *
              (0.8 + Math.random() * 0.4);
        } finally {
          e.pending = null;
          notify(e);
          resolve(e.profile);
          schedule();
        }
      }),
    );
    const operation = e.pending;
    drain();
    return operation;
  }
  function watch(pk, fn) {
    if (!/^[0-9a-f]{64}$/.test(pk || "")) return () => {};
    const e = entry(pk);
    e.listeners.add(fn);
    fn({ profile: e.profile, status: e.status, due: e.due });
    void load(pk, { observed: true });
    schedule();
    return () => {
      e.listeners.delete(fn);
      schedule();
    };
  }
  const statusText = (status) =>
    ({
      idle: "Loading profile…",
      loading: "Loading profile…",
      error: "Profile unavailable · retrying later",
      offline: "Offline · retrying later",
      missing: "No public profile",
      ready: "",
    })[status] || "";
  let dialog = null,
    unwatch = null,
    opener = null,
    modalRun = 0;
  function close() {
    modalRun++;
    unwatch?.();
    unwatch = null;
    if (dialog?.open) dialog.close();
    if (opener?.isConnected) opener.focus();
    opener = null;
  }
  function open(pk, source) {
    if (!/^[0-9a-f]{64}$/.test(pk || "")) return;
    close();
    opener = source || document.activeElement;
    const run = ++modalRun;
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "public-profile-dialog";
      dialog.setAttribute("aria-labelledby", "publicProfileTitle");
      dialog.innerHTML =
        '<div class="public-profile-heading"><h2 id="publicProfileTitle">Public profile</h2><button type="button" aria-label="Close profile">Close</button></div><div class="public-profile-avatar">👤</div><h3 class="public-profile-name"></h3><p class="public-profile-status" role="status"></p><p class="public-profile-bio"></p><div class="public-profile-npub"></div><button type="button" class="public-profile-copy">Copy npub</button>';
      document.body.append(dialog);
      dialog.querySelector("button").onclick = close;
      dialog.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const buttons = [...dialog.querySelectorAll("button:not(:disabled)")];
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
      dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        close();
      });
      dialog.addEventListener("click", (e) => {
        const r = dialog.getBoundingClientRect();
        if (
          e.target === dialog &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom)
        )
          close();
      });
    }
    const name = dialog.querySelector(".public-profile-name"),
      bio = dialog.querySelector(".public-profile-bio"),
      avatar = dialog.querySelector(".public-profile-avatar"),
      npub = dialog.querySelector(".public-profile-npub"),
      copy = dialog.querySelector(".public-profile-copy");
    npub.textContent = pk;
    copy.disabled = true;
    copy.textContent = "Copy npub";
    copy.onclick = null;
    dialog.showModal();
    dialog.querySelector("button").focus();
    unwatch = watch(pk, ({ profile, status }) => {
      if (run !== modalRun) return;
      name.textContent = profile?.name || `${pk.slice(0, 8)}…${pk.slice(-6)}`;
      bio.textContent = profile?.about || "No bio provided.";
      dialog.querySelector(".public-profile-status").textContent =
        statusText(status);
      const url = safeUrl(profile?.picture);
      if (avatar.dataset.url !== url) {
        avatar.dataset.url = url;
        avatar.textContent = "👤";
        if (url) {
          const img = document.createElement("img");
          img.alt = "";
          img.referrerPolicy = "no-referrer";
          img.onerror = () => img.remove();
          img.src = url;
          avatar.append(img);
        }
      }
    });
    void import("https://esm.sh/nostr-tools@2?bundle")
      .then(({ nip19 }) => {
        if (run !== modalRun) return;
        const value = nip19.npubEncode(pk);
        npub.textContent = value;
        copy.disabled = false;
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(value);
            if (run === modalRun) copy.textContent = "Copied";
          } catch {
            if (run === modalRun) copy.textContent = "Copy failed · try again";
          }
        };
      })
      .catch(() => {
        if (run === modalRun) copy.textContent = "Could not encode npub";
      });
  }
  window.addEventListener("player-ready", close);
  window.addEventListener("pagehide", () => {
    suspended = true;
    close();
    clearTimeout(timer);
    timer = null;
  });
  window.addEventListener("pageshow", () => {
    suspended = false;
    for (const e of entries.values()) if (e.listeners.size) notify(e);
    schedule();
  });
  function set(pk, profile) {
    const e = entry(pk);
    e.revision++;
    e.profile = profile;
    e.status = "ready";
    e.due = Date.now() + 900000;
    e.failures = 0;
    notify(e);
    schedule();
  }
  window.Word5Profiles = {
    load,
    watch,
    set,
    safeUrl,
    statusText,
    open,
    close,
    fetch: async () => {
      throw new Error("Profile transport unavailable");
    },
  };
})();
