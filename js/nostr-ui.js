// UI helpers: avatar dropdown, keys modal, import/export, toast.
(function () {
  const state = { revealed: false };

  const $ = (id) => document.getElementById(id);

  function shortNpub(npub) {
    if (!npub) return "Session";
    return npub.length > 14 ? `${npub.slice(0, 8)}…${npub.slice(-4)}` : npub;
  }

  function showToast(msg) {
    let bar = $("toastBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "toastBar";
      bar.style.position = "fixed";
      bar.style.bottom = "16px";
      bar.style.left = "50%";
      bar.style.transform = "translateX(-50%)";
      bar.style.padding = "10px 14px";
      bar.style.background = "rgba(12, 15, 26, 0.9)";
      bar.style.color = "#f5d100";
      bar.style.fontSize = "12px";
      bar.style.border = "1px solid #f5d100";
      bar.style.borderRadius = "6px";
      bar.style.zIndex = "1500";
      bar.style.transition = "opacity 0.2s ease";
      document.body.appendChild(bar);
    }
    bar.textContent = msg;
    bar.style.opacity = "1";
    clearTimeout(bar._hide);
    bar._hide = setTimeout(() => {
      bar.style.opacity = "0";
    }, 1800);
  }

  async function renderQr(text) {
    const qrContainer = $("keysQrContainer");
    if (!qrContainer) return;
    qrContainer.innerHTML = "";
    const { default: QRCode } = await import(
      "https://esm.sh/qrcode@1.5.3?bundle"
    );
    await QRCode.toCanvas(qrContainer, text, { margin: 1, width: 200 });
  }

  function renderKeys(player) {
    const npubEl = $("keysModalNpub");
    const nsecEl = $("keysModalNsec");
    const toggle = $("keysModalToggle");
    const note = $("keysModalNote");
    if (!npubEl || !nsecEl || !toggle || !note) return;
    const linked = player?.linked_npub ? `\nlinked npub: ${player.linked_npub}` : "";
    npubEl.textContent = `session npub: ${player?.npub || "—"}${linked}`;
    const hasNsec = player?.auth_mode === "session" && player?.nsec;
    if (hasNsec) {
      nsecEl.textContent = state.revealed
        ? `nsec: ${player.nsec}`
        : `nsec: ${"•".repeat(Math.max(16, String(player.nsec).length))}`;
      toggle.style.display = "";
      toggle.textContent = state.revealed ? "🙈" : "👁";
    } else {
      nsecEl.textContent =
        player?.auth_mode === "nip07"
          ? "Using NIP-07 signer; session nsec hidden."
          : "No session key available.";
      toggle.style.display = "none";
    }
    note.textContent =
      player?.auth_mode === "nip07"
        ? "Extension signs events. Session key is fallback only."
        : "Stored in this browser. Export/import to move devices.";
  }

  function renderAvatar(player) {
    const bubble = $("nostrAvatarBubble");
    const label = $("nostrAvatarLabel");
    const mode = player?.auth_mode === "nip07" ? "NIP-07" : "Session";
    if (bubble) bubble.textContent = mode === "NIP-07" ? "🟣" : "🟢";
    if (label) label.textContent = `${mode}: ${shortNpub(
      player?.linked_npub || player?.npub
    )}`;
    document.querySelectorAll(".session-only").forEach((el) => {
      el.style.display = player?.auth_mode === "session" ? "" : "none";
    });
  }

  function bindEvents() {
    const toggle = $("keysModalToggle");
    if (toggle) {
      toggle.onclick = () => {
        state.revealed = !state.revealed;
        renderKeys(window.NostrSession?.getPlayer());
      };
    }

    const copyBtn = $("keysCopyBtn");
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          const nsec = window.NostrSession?.exportNsec();
          if (!nsec) throw new Error("No session nsec to copy");
          await navigator.clipboard.writeText(nsec);
          showToast("Copied session nsec");
        } catch (e) {
          showToast(`Copy failed: ${e?.message || e}`);
        }
      };
    }

    const qrBtn = $("keysQrBtn");
    if (qrBtn) {
      qrBtn.onclick = async () => {
        try {
          const nsec = window.NostrSession?.exportNsec();
          if (!nsec) throw new Error("No session nsec");
          await renderQr(nsec);
          showKeysModal(true);
        } catch (e) {
          showToast(`QR failed: ${e?.message || e}`);
        }
      };
    }

    const importBtn = $("keysImportBtn");
    const importInput = $("keysImportInput");
    if (importBtn && importInput) {
      importBtn.onclick = async () => {
        const value = importInput.value.trim();
        if (!value) return;
        try {
          await window.NostrSession.importNsec(value);
          importInput.value = "";
          state.revealed = false;
          showToast("Imported session key");
          renderKeys(window.NostrSession.getPlayer());
          renderAvatar(window.NostrSession.getPlayer());
        } catch (e) {
          showToast(`Import failed: ${e?.message || e}`);
        }
      };
    }

    const newPlayerBtn = $("keysNewPlayerBtn");
    if (newPlayerBtn) {
      newPlayerBtn.onclick = async () => {
        await window.NostrSession.resetPlayer();
        state.revealed = false;
        showToast("New session created");
        renderKeys(window.NostrSession.getPlayer());
        renderAvatar(window.NostrSession.getPlayer());
      };
    }

    const loginBtns = document.querySelectorAll(".nostrLoginBtn");
    loginBtns.forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await window.NostrSession.loginWithNip07();
          showToast("Linked NIP-07 signer");
          renderKeys(window.NostrSession.getPlayer());
          renderAvatar(window.NostrSession.getPlayer());
        } catch (e) {
          showToast(`Login failed: ${e?.message || e}`);
        }
      });
    });

    const dropdownToggle = $("nostrAvatarBubble");
    const dropdown = $("nostrAvatarDropdown");
    if (dropdownToggle && dropdown) {
      dropdownToggle.addEventListener("click", () => {
        dropdown.classList.toggle("open");
      });
      document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && e.target !== dropdownToggle) {
          dropdown.classList.remove("open");
        }
      });
    }

    const viewKeysBtn = $("keysOpenBtn");
    if (viewKeysBtn) {
      viewKeysBtn.onclick = () => showKeysModal(true);
    }

    const modal = $("keysModal");
    const close = $("keysModalClose");
    if (modal && close) {
      close.onclick = () => showKeysModal(false);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) showKeysModal(false);
      });
    }

    // Streak modal bindings
    const checkStreakBtn = $("checkStreakBtn");
    if (checkStreakBtn) {
      checkStreakBtn.onclick = () => {
        $("nostrAvatarDropdown")?.classList.remove("open");
        showStreakModal(true);
      };
    }

    const streakModal = $("streakModal");
    const streakClose = $("streakModalClose");
    if (streakModal && streakClose) {
      streakClose.onclick = () => showStreakModal(false);
      streakModal.addEventListener("click", (e) => {
        if (e.target === streakModal) showStreakModal(false);
      });
    }
  }

  function showKeysModal(show) {
    const modal = $("keysModal");
    if (!modal) return;
    modal.style.display = show ? "flex" : "none";
    if (show) {
      state.revealed = false;
      renderKeys(window.NostrSession?.getPlayer());
    }
  }

  function showStreakModal(show) {
    const modal = $("streakModal");
    if (!modal) return;
    modal.style.display = show ? "flex" : "none";
    if (show) {
      fetchAndDisplayStats();
    }
  }

  async function fetchAndDisplayStats() {
    const content = $("streakModalContent");
    if (!content) return;

    content.innerHTML = '<div style="color:#818384;padding:24px;">Loading from Nostr...</div>';

    try {
      // Wait for NostrSigners
      if (window.NostrSigners?.ready) {
        await window.NostrSigners.ready();
      }

      if (!window.NostrSigners) {
        content.innerHTML = '<div style="color:#818384;padding:24px;">Nostr not available</div>';
        return;
      }

      const signer = await window.NostrSigners.getActiveSigner();
      const pubkey = await signer.getPublicKey();

      const { SimplePool } = await import("https://esm.sh/nostr-tools@2?bundle");
      const pool = new SimplePool();
      const relays = window.NostrPost?.DEFAULT_RELAYS || [
        "wss://relay.damus.io",
        "wss://nos.lol",
        "wss://relay.snort.social"
      ];

      // Query for this user's word5 posts
      const events = await pool.querySync(relays,
        { kinds: [1], authors: [pubkey], "#t": ["word5"], limit: 100 }
      );

      try { pool.close(relays); } catch (_) {}

      if (!events || events.length === 0) {
        content.innerHTML = `
          <div style="padding:24px;">
            <div style="font-size:48px;margin-bottom:16px;">🎮</div>
            <div style="color:#818384;">No games found on Nostr yet.</div>
            <div style="color:#818384;font-size:12px;margin-top:8px;">Play a game and post to Nostr to track your stats!</div>
          </div>
        `;
        return;
      }

      // Sort by created_at descending
      events.sort((a, b) => b.created_at - a.created_at);

      // Parse stats from events
      let maxStreak = 0;
      let totalPlayed = 0;
      let totalWon = 0;
      let currentStreak = 0;
      let mostRecentPuzzle = 0;
      let firstGameDate = null;
      let lastGameDate = null;

      for (const event of events) {
        const tags = Object.fromEntries(
          event.tags.filter(t => ["streak", "maxStreak", "played", "won", "puzzle"].includes(t[0]))
            .map(t => [t[0], parseInt(t[1], 10) || 0])
        );

        if (tags.maxStreak > maxStreak) maxStreak = tags.maxStreak;
        if (tags.played > totalPlayed) totalPlayed = tags.played;
        if (tags.won > totalWon) totalWon = tags.won;

        // Track dates
        const eventDate = new Date(event.created_at * 1000);
        if (!lastGameDate) lastGameDate = eventDate;
        firstGameDate = eventDate;

        // Most recent event for current streak
        if (event === events[0]) {
          currentStreak = tags.streak || 0;
          const puzzleMatch = event.content.match(/WORD5\s*#(\d+)/i);
          mostRecentPuzzle = puzzleMatch ? parseInt(puzzleMatch[1], 10) : (tags.puzzle || 0);
        }
      }

      // Check if streak is still valid (played yesterday or today)
      const now = Date.now();
      const msPerDay = 24 * 60 * 60 * 1000;
      const currentPeriod = Math.floor(now / msPerDay);
      const puzzlePeriod = mostRecentPuzzle; // puzzle number roughly corresponds to period

      // Streak valid if last game was recent (within ~2 days)
      const daysSinceLastGame = lastGameDate ? Math.floor((now - lastGameDate.getTime()) / msPerDay) : 999;
      const streakValid = daysSinceLastGame <= 2;
      const displayStreak = streakValid ? currentStreak : 0;

      const winPct = totalPlayed > 0 ? Math.round((totalWon / totalPlayed) * 100) : 0;
      const daysPlaying = firstGameDate && lastGameDate
        ? Math.max(1, Math.ceil((lastGameDate.getTime() - firstGameDate.getTime()) / msPerDay) + 1)
        : 1;

      content.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
          <div style="background:#2a2a2b;border-radius:8px;padding:16px;">
            <div style="font-size:32px;font-weight:700;color:#9333ea;">${displayStreak}</div>
            <div style="font-size:11px;color:#818384;text-transform:uppercase;">Current Streak</div>
          </div>
          <div style="background:#2a2a2b;border-radius:8px;padding:16px;">
            <div style="font-size:32px;font-weight:700;color:#f97316;">${maxStreak}</div>
            <div style="font-size:11px;color:#818384;text-transform:uppercase;">Best Streak</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
          <div style="background:#2a2a2b;border-radius:8px;padding:12px;">
            <div style="font-size:24px;font-weight:700;">${totalPlayed}</div>
            <div style="font-size:10px;color:#818384;">Played</div>
          </div>
          <div style="background:#2a2a2b;border-radius:8px;padding:12px;">
            <div style="font-size:24px;font-weight:700;">${totalWon}</div>
            <div style="font-size:10px;color:#818384;">Won</div>
          </div>
          <div style="background:#2a2a2b;border-radius:8px;padding:12px;">
            <div style="font-size:24px;font-weight:700;">${winPct}%</div>
            <div style="font-size:10px;color:#818384;">Win Rate</div>
          </div>
        </div>
        <div style="font-size:11px;color:#818384;border-top:1px solid #3a3a3c;padding-top:12px;">
          ${events.length} posts on Nostr${!streakValid && currentStreak > 0 ? " · Streak expired" : ""}
        </div>
      `;
    } catch (e) {
      console.error("[Streak] Error:", e);
      content.innerHTML = `
        <div style="padding:24px;">
          <div style="color:#f97316;">Error loading stats</div>
          <div style="color:#818384;font-size:12px;margin-top:8px;">${e?.message || e}</div>
        </div>
      `;
    }
  }

  function init() {
    bindEvents();
    const player = window.NostrSession?.getPlayer();
    renderKeys(player);
    renderAvatar(player);
    if (window.NostrSession && window.NostrSession.whenReady) {
      window.NostrSession.whenReady.then((p) => {
        renderKeys(p);
        renderAvatar(p);
      });
    }
    window.addEventListener("player-ready", (e) => {
      renderKeys(e.detail.player);
      renderAvatar(e.detail.player);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.NostrUI = { renderKeys, renderAvatar, showKeysModal, showStreakModal, showToast };
})();
