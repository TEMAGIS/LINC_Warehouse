// ---------------------------------------------------------------------------
// Item panel (opens from a row on the Stock tab): where the item is and how much, Receive / Move /
// Stage right there, the library
// details, and the item's recent history. Everything it does reuses the dialogs the rest of the app uses.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { $, esc, fmtDateTime } from "./shared/util.js";
import { toast } from "./shared/ui.js";
import { S, itemParts, itemName, findLib, normSku } from "./state.js";
import { balanceCode, codeLabel, isPicklineRow } from "./loc.js";
import { onHand } from "./data.js";
import { fmtNum, fmtGallons, gallonsFor, unitLabel, ci } from "./units.js";
import { openReceive, openMove, openStage } from "./dialogs.js";
import { ownersActive, canActOn, ownerName } from "./owners.js";
import { plannedQty } from "./shipments.js";
import { openEditDialog, libCanUpdate } from "./libtab.js";
import { openSetOwner } from "./stock.js";

let cur = null; // { sku }
export const isDrawerOpen = () => !!cur;

export function openDrawer(sku) {
  cur = { sku: normSku(sku), tab: "where" };
  render();
}

export function closeDrawer() {
  cur = null;
  const host = $("#drawer-host");
  if (host) host.innerHTML = "";
}

/** Redraws after the data changed (called by the app's refresh). Closes itself if the item is gone entirely. */
export function refreshDrawer() {
  if (cur) render();
}

const rowsFor = (sku) => S.balances.filter((r) => normSku(r.item_sku) === sku && onHand(r) > 0);

function statusPill(total) {
  if (total <= 0) return `<span class="status-pill st-bad">Out of stock</span>`;
  if (total <= CONFIG.LOW_STOCK) return `<span class="status-pill st-pending">Low stock</span>`;
  return `<span class="status-pill st-ok">In stock</span>`;
}

function render() {
  if (!cur) return;
  const host = $("#drawer-host");
  if (!host) return;
  const sku = cur.sku;
  const tab = cur.tab || "where";
  const rows = rowsFor(sku).sort((a, b) => Number(isPicklineRow(a)) - Number(isPicklineRow(b)) || balanceCode(a).localeCompare(balanceCode(b), undefined, { numeric: true }));
  const lib = findLib(sku);
  const base = rows[0] || S.balances.find((r) => normSku(r.item_sku) === sku) || { item_sku: sku };
  const p = itemParts(base, lib);
  const total = rows.reduce((n, r) => n + onHand(r), 0);
  const staged = rows.filter(isPicklineRow).reduce((n, r) => n + onHand(r), 0);
  const unit = unitLabel(lib, base.unit_of_measure);
  const gal = gallonsFor(lib, total);
  const edit = S.canEdit;
  const movable = rows.filter((r) => canActOn(r.property_owner));
  const canMove = edit && movable.length > 0;

  // Total for everything with the same item name (all brands, sizes and barcodes): "Total Water", "Total Cat Treats".
  let grp = null;
  if (!p.generic) {
    const key = p.name.trim().toLowerCase();
    const bySku = new Map();
    for (const r of S.balances) {
      if (itemName(r).trim().toLowerCase() !== key || onHand(r) <= 0) continue;
      const k = normSku(r.item_sku);
      const e = bySku.get(k) || { sku: k, row: r, qty: 0, staged: 0, gal: 0 };
      e.qty += onHand(r);
      if (isPicklineRow(r)) e.staged += onHand(r);
      e.gal += gallonsFor(findLib(k), onHand(r));
      bySku.set(k, e);
    }
    const list = [...bySku.values()].sort((a, b) => b.qty - a.qty);
    if (list.length) grp = { name: p.name, list, qty: list.reduce((n, e) => n + e.qty, 0), staged: list.reduce((n, e) => n + e.staged, 0), gal: list.reduce((n, e) => n + e.gal, 0) };
  }

  const promised = rows.reduce((n, r) => n + plannedQty(r.item_sku, balanceCode(r), r.lot_number, ownersActive() ? { owner: String(r.property_owner || "") } : {}), 0);

  const onHandRows = rows.length
    ? rows.map((r) => {
        const code = balanceCode(r);
        const mine = canActOn(r.property_owner);
        const pl = isPicklineRow(r);
        return `<tr>
          <td><span class="mono">${esc(codeLabel(code))}</span>${pl ? ` <span class="tag">Pick line</span>` : ""}${r.lot_number ? `<div class="sub">lot ${esc(r.lot_number)}</div>` : ""}${ownersActive() && r.property_owner ? `<div class="sub"><span class="owner-tag">${esc(ownerName(r.property_owner))}</span></div>` : ""}</td>
          <td class="num">${fmtNum(onHand(r))}</td>
          <td class="dr-btns">${edit && mine ? `<button type="button" data-d="move" data-code="${esc(code)}" data-lot="${esc(r.lot_number || "")}">Move</button>${pl ? "" : `<button type="button" data-d="stage">To pick line</button>`}` : ""}${edit && S.isAdmin && ownersActive() ? `<button type="button" data-d="owner" data-oid="${esc(r._oid)}">Owner</button>` : ""}</td></tr>`;
      }).join("")
    : `<tr><td colspan="3" class="empty">None in stock.</td></tr>`;

  const hist = S.txns.filter((t) => normSku(t.item_sku) === sku).slice(0, 12);
  const histHtml = hist.length
    ? `<ul class="timeline">${hist.map((t) => {
        const place = t.transaction_type === "Move" ? `${side(t, "from_")} → ${side(t, "to_")}` : t.transaction_type === "Receive" ? `into ${side(t, "to_")}` : `from ${side(t, "from_")}`;
        const st = String(t.processing_status || "Pending");
        return `<li><b>${esc(t.transaction_type)}</b> ${fmtNum(t.quantity)} <span class="sub">${esc(place)}${t.shipment_id ? " · " + esc(t.shipment_id) : ""}</span>
          <div class="sub">${esc(fmtDateTime(t.transaction_datetime))} · ${esc(t.performed_by || "")}${st !== "Success" ? ` · <b>${esc(st)}</b>` : ""}</div></li>`;
      }).join("")}</ul>`
    : `<p class="sub">No transactions for this item yet.</p>`;

  const detail = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : "");
  host.innerHTML = `
    <div class="scrim" data-d="close"></div>
    <aside class="drawer" role="dialog" aria-label="Item details">
      <header>
        <div style="flex:1;min-width:0"><div class="mono sub">${esc(sku)}</div><h2>${esc(p.title)}</h2>${p.generic ? `<div class="sub">${esc(p.name)}</div>` : `<div class="sub">${esc(p.mm)}</div>`}</div>
        ${statusPill(total)}<button type="button" class="icon-btn" data-d="close" aria-label="Close">&times;</button>
      </header>
      <div class="body">
        <div class="dr-stats">
          <div class="dr-stat main"><span class="dr-num">${fmtNum(total)}</span><span class="sub">${esc(unit)} on hand${gal > 0 ? ` · ≈ ${fmtGallons(gal)} gal` : ""}</span></div>
          <div class="dr-stat"><span class="dr-num sm">${fmtNum(staged)}</span><span class="sub">on the pick line</span></div>
          <div class="dr-stat"><span class="dr-num sm">${fmtNum(promised)}</span><span class="sub">promised to plans</span></div>
        </div>
        ${grp ? `<details class="dr-group"><summary><b>Total ${esc(grp.name)}</b> <span class="dr-gnum">${fmtNum(grp.qty)}</span> <span class="sub">across ${grp.list.length} item${grp.list.length === 1 ? "" : "s"} · ${fmtNum(grp.staged)} on the pick line${grp.gal > 0 ? ` · ≈ ${fmtGallons(grp.gal)} gal` : ""}</span></summary>
          <ul class="dr-glist">${grp.list.map((e) => { const ip = itemParts(e.row, findLib(e.sku)); return `<li><span><b>${esc(ip.mm || ip.title)}</b> <span class="sub">${esc(e.sku)}</span></span><span>${fmtNum(e.qty)}${e.sku === sku ? ` <span class="tag">this item</span>` : ` <button type="button" data-d="open-sku" data-sku="${esc(e.sku)}">View</button>`}</span></li>`; }).join("")}</ul></details>` : ""}
        ${edit ? `<div class="drawer-actions"><button type="button" class="btn-primary" data-d="receive">Receive more</button>${canMove ? `<button type="button" data-d="move-item">Move</button>` : ""}${staged < total ? `<button type="button" data-d="stage">Stage to pick line</button>` : ""}</div>` : ""}
        <div class="dr-tabs" role="tablist">
          ${[["where", "Locations", rows.length], ["info", "Details", 0], ["hist", "History", hist.length]].map(([k, l, n]) => `<button type="button" role="tab" class="dr-tab${tab === k ? " active" : ""}" aria-selected="${tab === k}" data-d="tab" data-tab="${k}">${l}${n ? ` <span class="dr-count">${n}</span>` : ""}</button>`).join("")}
        </div>
        ${tab === "where" ? `<div class="card">
          <table class="mini-table"><thead><tr><th>Where</th><th class="num">Qty</th><th></th></tr></thead><tbody>${onHandRows}</tbody></table>
        </div>` : ""}
        ${tab === "info" ? `
        <div class="card">
          <dl class="kv">
            ${detail("Category", ci(lib, "item_category") || base.category)}
            ${detail("Make / model", p.mm)}
            ${detail("Counted as", unit)}
            ${detail("Barcode", sku)}
            ${detail("Description", p.desc)}
            ${detail("Size", ci(lib, "size"))}
          </dl>
          ${lib ? (edit && libCanUpdate() ? `<button type="button" class="btn-sm" data-d="edit" style="margin-top:.6rem">Edit details</button>` : "") : `<p class="sub">This barcode isn't in the Barcode Library yet.</p>`}
        </div>` : ""}
        ${tab === "hist" ? histHtml : ""}
      </div>
    </aside>`;
}

/** Where a transaction touched, as a readable label (same rule as the Transactions tab). */
function side(t, p) {
  const code = t[`${p}location_scan`];
  if (code) return codeLabel(code);
  return [t[`${p}zone`], t[`${p}row`], t[`${p}bay`], t[`${p}level`], t[`${p}position`]].filter((x) => x !== null && x !== undefined && x !== "").join("-");
}

function act(e) {
  const b = e.target.closest("[data-d]");
  if (!b || !cur) return;
  const d = b.dataset.d;
  const sku = cur.sku;
  if (d === "close") return closeDrawer();
  if (d === "open-sku") return openDrawer(b.dataset.sku);
  if (d === "tab") { cur.tab = b.dataset.tab; return render(); }
  if (d === "receive") return openReceive({ sku });
  if (d === "move-item") {
    // one place to move from: open the Move dialog ready to go; several: pick the shelf on the Locations tab
    const rowsHere = rowsFor(sku).filter((r) => canActOn(r.property_owner));
    if (rowsHere.length === 1) { const r = rowsHere[0]; return openMove({ from: balanceCode(r), sku, lot: r.lot_number || "" }); }
    cur.tab = "where"; render();
    return toast("Choose the shelf to move from with the Move button beside it.", "info");
  }
  if (d === "move") return openMove({ from: b.dataset.code, sku, lot: b.dataset.lot });
  if (d === "stage") return openStage({ sku });
  if (d === "owner") return openSetOwner(S.balances.find((r) => String(r._oid) === b.dataset.oid));
  if (d === "edit") { const lib = findLib(sku); if (lib) openEditDialog(lib); return; }
}

let wired = false;
export function initDrawer() {
  if (wired) return;
  wired = true;
  const host = $("#drawer-host");
  if (host) host.addEventListener("click", act);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cur && !document.querySelector(".modal-backdrop")) closeDrawer();
  });
  S.render.drawer = refreshDrawer;
}
