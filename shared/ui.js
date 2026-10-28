// Toasts, modal dialogs, status bar.
import { esc } from "./util.js";

let toastHost;
export function toast(message, kind = "info", ms = 4500) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.id = "toast-host";
    toastHost.setAttribute("role", "status");
    toastHost.setAttribute("aria-live", "polite");
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function setStatus(message, kind = "") {
  const bar = document.getElementById("status-bar");
  if (!bar) return;
  if (!message) {
    bar.hidden = true;
    bar.textContent = "";
    return;
  }
  bar.hidden = false;
  bar.className = kind;
  bar.textContent = message;
}

/**
 * Opens a modal. `body` is an HTML string (caller must esc() any data).
 * buttons: [{label, kind: 'primary'|'danger'|'', action: (modal)=>void|Promise, close?: bool}]
 * Returns { el, body, close, setError, setBusy }.
 */
export function openModal({ title, body, buttons = [], wide = false, onClose = null }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal${wide ? " modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">&times;</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-error" role="alert" hidden></div>
      <div class="modal-foot"></div>
    </div>`;
  document.body.appendChild(backdrop);
  const prevFocus = document.activeElement;
  const foot = backdrop.querySelector(".modal-foot");
  const api = {
    el: backdrop,
    body: backdrop.querySelector(".modal-body"),
    close() {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      if (onClose) onClose();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    },
    setError(msg) {
      const e = backdrop.querySelector(".modal-error");
      e.hidden = !msg;
      e.textContent = msg || "";
    },
    setBusy(busy) {
      foot.querySelectorAll("button").forEach((b) => (b.disabled = busy));
      backdrop.classList.toggle("busy", busy);
    },
  };
  const onKey = (e) => {
    if (e.key === "Escape") api.close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) api.close();
  });
  backdrop.querySelector("[data-close]").addEventListener("click", () => api.close());
  buttons.forEach((b) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.label;
    if (b.kind) btn.className = `btn-${b.kind}`;
    if (b.id) btn.id = b.id;
    btn.addEventListener("click", async () => {
      api.setError("");
      try {
        api.setBusy(true);
        const result = b.action ? await b.action(api) : undefined;
        api.setBusy(false);
        if (b.close !== false && result !== false) api.close();
      } catch (err) {
        api.setBusy(false);
        api.setError(err && err.message ? err.message : String(err));
      }
    });
    foot.appendChild(btn);
  });
  const first = backdrop.querySelector("input:not([type=hidden]), select, textarea");
  if (first) first.focus();
  return api;
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", kind = "primary" }) {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      body: `<p>${esc(message)}</p>`,
      onClose: () => {
        if (!settled) resolve(false);
      },
      buttons: [
        { label: "Cancel", action: () => { settled = true; resolve(false); } },
        { label: confirmLabel, kind, action: () => { settled = true; resolve(true); } },
      ],
    });
  });
}
