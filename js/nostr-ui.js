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

  window.NostrUI = { renderKeys, renderAvatar, showKeysModal, showToast };
})();
