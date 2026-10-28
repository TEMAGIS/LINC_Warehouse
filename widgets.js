// ---------------------------------------------------------------------------
// Small reusable pieces for the dialogs: scan boxes and the item picker.
// ---------------------------------------------------------------------------
import { esc } from "./shared/util.js";
import { S, findLib, normSku, itemName } from "./state.js";
import { ci, unitLabel, fmtNum } from "./units.js";
import { scanOnce } from "./scanner.js";
import { openAddToLibrary, libTitle } from "./library.js";

/** Label + input + camera button. Pair with wireScan(root). */
export function scanInput({ id, label, placeholder = "", value = "", hint = "" }) {
  return `<label>${esc(label)}
    <span class="scan-row"><input id="${esc(id)}" data-scan-input value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="characters" />
    <button type="button" data-scan="${esc(id)}" aria-label="Scan ${esc(label)} with the camera">Scan</button></span>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</label>`;
}

/** Camera buttons fill their input and fire `change`; Enter in a scan box fires `change` too (wedge scanners). */
export function wireScan(root) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-scan]");
    if (!b || !root.contains(b)) return;
    const input = root.querySelector("#" + b.dataset.scan);
    if (!input) return;
    const txt = await scanOnce("Point the camera at the barcode");
    if (txt) {
      input.value = txt;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = e.target.closest && e.target.closest("[data-scan-input]");
    if (!input) return;
    e.preventDefault();
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const words = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean);
const looksLikeCode = (t) => /^[A-Za-z0-9\-_.]{5,}$/.test(t);

/** Items currently in stock, one entry per SKU: [{sku, name, qty}] */
export function stockItems() {
  const m = new Map();
  for (const r of S.balances) {
    const q = Number(r.quantity_on_hand) || 0;
    if (q <= 0) continue;
    const sku = normSku(r.item_sku);
    const e = m.get(sku) || { sku, name: itemName(r), qty: 0 };
    e.qty += q;
    m.set(sku, e);
  }
  return [...m.values()];
}

/**
 * Item picker. mode "library": any Barcode Library item (unknown barcodes offer "Add to library").
 * mode "stock": only items with stock on hand.
 * host: element to render into. onPick({sku, lib, name}) fires on choice.
 */
export function itemPicker(host, { mode = "library", onPick = () => {}, label = "Item" } = {}) {
  const uid = "ip" + Math.random().toString(36).slice(2, 7);
  host.innerHTML = `
    <div class="ip">
      ${scanInput({ id: uid, label: `${label} — scan or type a barcode or name`, placeholder: "Scan barcode, or type to search" })}
      <div class="ip-results" id="${uid}-res" role="listbox" aria-label="Matching items"></div>
      <div class="ip-picked" id="${uid}-picked" hidden></div>
    </div>`;
  const input = host.querySelector("#" + uid);
  const res = host.querySelector("#" + uid + "-res");
  const picked = host.querySelector("#" + uid + "-picked");
  wireScan(host);
  let current = null;

  const choose = (p) => {
    current = p;
    res.innerHTML = "";
    picked.hidden = false;
    const sub = [p.sku, p.lib ? unitLabel(p.lib) : ""].filter(Boolean).join(" · ");
    picked.innerHTML = `<div><strong>${esc(p.name)}</strong><div class="sub">${esc(sub)}</div></div><button type="button" data-ip-change>Change</button>`;
    input.closest("label").hidden = true;
    onPick(p);
  };
  picked.addEventListener("click", (e) => {
    if (!e.target.closest("[data-ip-change]")) return;
    current = null;
    picked.hidden = true;
    input.closest("label").hidden = false;
    input.value = "";
    input.focus();
    onPick(null);
  });

  const fromLib = (lib) => ({ sku: normSku(ci(lib, "barcode")), lib, name: String(ci(lib, "item") ?? "").trim() || libTitle(lib) });

  const search = (commit = true) => {
    const t = input.value.trim();
    res.innerHTML = "";
    if (!t) return;
    const inStock = mode === "stock" ? new Set(stockItems().map((s) => s.sku)) : null;
    // 1) exact barcode
    const lib = findLib(t);
    if (lib && (!inStock || inStock.has(normSku(ci(lib, "barcode"))))) return choose(fromLib(lib));
    if (mode === "stock") {
      const hit = stockItems().find((s) => s.sku === t);
      if (hit) return choose({ sku: hit.sku, lib: findLib(hit.sku), name: hit.name });
    }
    // 2) words across item / make / model / description / barcode
    const ws = words(t);
    let found = [];
    if (mode === "stock") {
      found = stockItems()
        .filter((s) => ws.every((w) => `${s.name} ${s.sku}`.toLowerCase().includes(w)))
        .map((s) => ({ sku: s.sku, lib: findLib(s.sku), name: s.name, qty: s.qty }));
    } else {
      found = S.library
        .filter((r) => String(ci(r, "delete_flag") ?? "").toLowerCase() !== "yes")
        .filter((r) => ws.every((w) => [ci(r, "item"), ci(r, "make"), ci(r, "model"), ci(r, "description"), ci(r, "barcode")].join(" ").toLowerCase().includes(w)))
        .map(fromLib);
    }
    found = found.slice(0, 8);
    if (found.length) {
      res.innerHTML = found
        .map((f, i) => `<button type="button" class="ip-opt" data-i="${i}" role="option"><strong>${esc(f.name)}</strong> <span class="sub">${esc(f.sku)}${f.qty != null ? ` · ${fmtNum(f.qty)} in stock` : ""}</span></button>`)
        .join("");
      res.onclick = (e) => {
        const b = e.target.closest("[data-i]");
        if (b) choose(found[Number(b.dataset.i)]);
      };
      return;
    }
    if (!commit) return; // still typing: only suggest, don't offer "add" yet
    if (mode === "library" && looksLikeCode(t)) {
      res.innerHTML = `<div class="banner banner-warn"><span>Not in the Barcode Library: <code>${esc(t)}</code></span><button type="button" class="btn-primary" data-add>Add to library</button></div>`;
      res.onclick = (e) => {
        if (!e.target.closest("[data-add]")) return;
        openAddToLibrary({ barcode: t, onSaved: (row) => choose(fromLib(row)) });
      };
      return;
    }
    res.innerHTML = `<div class="sub">${mode === "stock" ? "Nothing in stock matches." : "No matching item."}</div>`;
  };
  input.addEventListener("change", () => search(true));
  input.addEventListener("input", () => { if (input.value.trim().length >= 3) search(false); else res.innerHTML = ""; });

  return {
    get: () => current,
    set: (p) => choose(p),
    focus: () => input.focus(),
  };
}
