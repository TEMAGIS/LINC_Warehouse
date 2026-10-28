// Small shared helpers (no DOM side effects at import time).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escape anything that goes into a template string. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const money = (n) =>
  n === null || n === undefined || n === "" || Number.isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fmtDate = (ms) =>
  ms ? new Date(Number(ms)).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";

export const fmtDateTime = (ms) =>
  ms
    ? new Date(Number(ms)).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";

export const DAY_MS = 86400000;
export const MONTH_MS = 30.4375 * DAY_MS;

export function randomCode(len = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => alphabet[b % alphabet.length]).join("");
}

/** e.g. REQ-261024-7K3Q */
export function newRequestId(now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `REQ-${yy}${mm}${dd}-${randomCode(4)}`;
}

/** e.g. TXN-261024-9XK2PQ */
export function newTxnId(now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `TXN-${yy}${mm}${dd}-${randomCode(6)}`;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** cols: [{key, label, get?}] */
export function toCSV(rows, cols) {
  const head = cols.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(c.get ? c.get(r) : r[c.key])).join(",")).join("\r\n");
  return head + "\r\n" + body;
}

const inFrame = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent = embedded
  }
};

function saveBlob(blob, filename, doc) {
  const a = doc.createElement("a");
  a.href = (doc.defaultView || window).URL.createObjectURL(blob);
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  return a;
}

/**
 * Downloads text as a file. When the app is embedded (e.g. an ArcGIS Experience
 * Builder Embed widget) the host iframe often blocks downloads, so the file is
 * saved from a small separate window instead.
 */
export function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  if (inFrame()) {
    const w = window.open("", "_blank", "width=480,height=220");
    if (w) {
      try {
        const d = w.document;
        d.title = filename;
        d.body.style.cssText = "font:14px Arial,sans-serif;padding:24px;";
        d.body.textContent = "";
        const msg = d.createElement("p");
        msg.textContent = "Your download should start automatically. If it does not, use the link below.";
        d.body.appendChild(msg);
        const a = saveBlob(blob, filename, d);
        a.textContent = "Download " + filename;
        const done = d.createElement("p");
        done.textContent = "You can close this window once the file has downloaded.";
        d.body.appendChild(done);
        return;
      } catch {
        w.close();
      }
    }
    // popup blocked -> fall through to the normal attempt
  }
  const a = saveBlob(blob, filename, document);
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

/** Case-insensitive "contains every word" match across several strings. */
export function matchesSearch(haystackParts, query) {
  const words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = haystackParts.map((p) => String(p ?? "").toLowerCase()).join(" ");
  return words.every((w) => hay.includes(w));
}

export const clampInt = (v, min, max) => {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
};

export const unique = (arr) => Array.from(new Set(arr.filter((v) => v !== null && v !== undefined && v !== "")));

/** Returns the URL only if it is a plain http(s) link, else "" (blocks javascript: etc.). */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "");

/** Parses CSV text (quotes, doubled quotes, CRLF, line breaks inside quotes, BOM) into an array of rows (arrays of strings). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}
