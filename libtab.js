// ---------------------------------------------------------------------------
// Library tab: the Barcode Library as a searchable list, with Add item (the same form the
// scanner uses), Edit, and Flag for delete. Records are never deleted: a flagged item is
// marked (delete_flag = "Yes", reason, who, when), hidden from the list and item pickers,
// and can be restored. Stock and transaction history that mention it keep working.
// ---------------------------------------------------------------------------
import { $, esc, debounce } from "./shared/util.js";
import { applyEdits } from "./shared/esri-client.js";
import { openModal, toast, confirmDialog } from "./shared/ui.js";
import { S } from "./state.js";
import { ci, fmtNum, unitLabel, gallonsPerCountUnit, gallonsPerVolume, fmtGallons } from "./units.js";
import { openAddToLibrary } from "./library.js";
import { loadLibrary, onHand } from "./data.js";
import { LIB_CATEGORIES, LIB_ITEMS, COUNT_UNITS, PACK_UNITS, VOLUME_UOMS, VOLUME_ITEMS, SIZE_ITEMS, SIZES } from "./lists.js";

const F = { q: "", cat: "", flagged: false, page: 1 };
const PAGE = 100;

const libCaps = () => String((S.info.lib && S.info.lib.raw && S.info.lib.raw.capabilities) || "").toLowerCase();
export const libCanCreate = () => libCaps().includes("create");
export const libCanUpdate = () => libCaps().includes("update");
export const isFlagged = (r) => String(ci(r, "delete_flag") ?? "").trim().toLowerCase() === "yes";

const barcodeOf = (r) => String(ci(r, "barcode") ?? "").trim();
const rowOid = (r) => r._oid ?? r[(S.info.lib && S.info.lib.objectIdField) || "OBJECTID"];

export function filterLibrary(rows, { q = "", cat = "", flagged = false } = {}) {
  const ws = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (isFlagged(r) !== !!flagged) return false;
    if (cat && String(ci(r, "item_category") ?? "") !== cat) return false;
    if (!ws.length) return true;
    const hay = ["barcode", "item", "make", "model", "description", "item_category", "size", "barcode_scan", "item_barcode"].map((k) => ci(r, k) ?? "").join(" ").toLowerCase();
    return ws.every((w) => hay.includes(w));
  });
}

/** Writes only fields that exist on the live layer (case-insensitive); null clears a value. */
function fitLib(attrs) {
  const names = new Map(((S.info.lib && S.info.lib.fields) || []).map((f) => [f.name.toLowerCase(), f.name]));
  const out = {};
  for (const [k, v] of Object.entries(attrs)) { const real = names.get(k.toLowerCase()); if (real && v !== undefined) out[real] = v; }
  return out;
}

async function updateLib(row, attrs) {
  const key = (S.info.lib && S.info.lib.objectIdField) || "OBJECTID";
  await applyEdits(S.urls.lib, { updates: [{ attributes: { ...fitLib(attrs), [key]: rowOid(row) } }] });
  await loadLibrary();
}

export function initLibTab() {
  const el = $("#screen-lib");
  el.addEventListener("input", debounce((e) => { if (e.target.id === "lt-q") { F.q = e.target.value; F.page = 1; renderRows(); } }, 150));
  el.addEventListener("change", (e) => {
    if (e.target.id === "lt-cat") F.cat = e.target.value;
    else if (e.target.id === "lt-flagged") F.flagged = e.target.checked;
    else return;
    F.page = 1;
    renderRows();
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const row = b.dataset.oid ? S.library.find((r) => String(rowOid(r)) === b.dataset.oid) : null;
    if (b.dataset.act === "more") { F.page += 1; renderRows(); }
    else if (b.dataset.act === "add") openAddToLibrary({ onSaved: () => renderLib() });
    else if (b.dataset.act === "edit" && row) openEditDialog(row);
    else if (b.dataset.act === "flag" && row) openFlagDialog(row);
    else if (b.dataset.act === "restore" && row) restore(row);
  });
  S.render.lib = renderLib;
}

export function renderLib() {
  const el = $("#screen-lib");
  const cats = [...new Set(S.library.map((r) => String(ci(r, "item_category") ?? "")).filter(Boolean))].sort();
  const canAdd = S.canEdit && libCanCreate();
  const nFlag = S.library.filter(isFlagged).length;
  el.innerHTML = `
    <div class="toolbar">
      <input id="lt-q" type="search" placeholder="Barcode, item, make, model" value="${esc(F.q)}" aria-label="Search the library" />
      <select id="lt-cat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => `<option ${F.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <label class="check"><input id="lt-flagged" type="checkbox" ${F.flagged ? "checked" : ""} /> Flagged for delete (${nFlag})</label>
      <span class="spacer"></span>
      ${canAdd ? `<button type="button" class="btn-primary" data-act="add">Add item</button>` : ""}
    </div>
    ${S.canEdit && !libCanCreate() && !libCanUpdate() ? `<div class="banner banner-warn">The Barcode Library service is read-only for your account, so items can't be added or edited here. In ArcGIS Online, turn on Editing for the Barcode Library item (and share it with editing).</div>` : ""}
    <div id="lt-table"></div>`;
  renderRows();
}

function renderRows() {
  const host = $("#lt-table");
  if (!host) return;
  const canChange = S.canEdit && libCanUpdate();
  const onBySku = new Map();
  for (const b of S.balances) onBySku.set(String(b.item_sku || "").trim(), (onBySku.get(String(b.item_sku || "").trim()) || 0) + onHand(b));
  const rows = filterLibrary(S.library, F).sort((a, b) => String(ci(a, "item") ?? "").localeCompare(String(ci(b, "item") ?? "")));
  const shown = rows.slice(0, F.page * PAGE);
  const body = shown.length
    ? shown.map((r) => {
        const bc = barcodeOf(r);
        const per = gallonsPerCountUnit(r);
        const oid = esc(rowOid(r));
        const acts = !canChange ? ""
          : isFlagged(r)
            ? `<button type="button" class="link-btn" data-act="restore" data-oid="${oid}">Restore</button>`
            : `<button type="button" class="link-btn" data-act="edit" data-oid="${oid}">Edit</button> <button type="button" class="link-btn" data-act="flag" data-oid="${oid}">Flag for delete</button>`;
        return `<tr class="${isFlagged(r) ? "row-inactive" : ""}">
          <td><span class="t">${esc(ci(r, "item") || "")}</span><div class="sub">${esc([ci(r, "make"), ci(r, "model")].filter(Boolean).join(" · "))}${ci(r, "size") ? " · " + esc(ci(r, "size")) : ""}</div>
            ${isFlagged(r) ? `<div class="sub">Flagged${ci(r, "flagged_by") ? " by " + esc(ci(r, "flagged_by")) : ""}${ci(r, "delete_reason") ? ": " + esc(ci(r, "delete_reason")) : ""}</div>` : ""}</td>
          <td class="mono">${esc(bc)}${ci(r, "barcode_type") === "Container" ? `<div class="sub">container ${esc(ci(r, "barcode_scan") || "")}</div>` : ""}</td>
          <td>${esc(ci(r, "item_category") || "")}</td>
          <td>${esc(unitLabel(r))}</td>
          <td class="num">${per > 0 ? esc(fmtGallons(per)) : ""}</td>
          <td class="num">${fmtNum(onBySku.get(bc) || 0)}</td>
          <td class="row-actions">${acts}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" class="empty">No items match.</td></tr>`;
  host.innerHTML = `<div class="table-wrap tall"><table class="grid"><thead><tr><th>Item</th><th>Barcode</th><th>Category</th><th>Unit</th><th class="num">Gal / unit</th><th class="num">On hand</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="sub" style="margin:.5rem 0">${fmtNum(rows.length)} item(s)${shown.length < rows.length ? ` · showing ${fmtNum(shown.length)} <button type="button" class="link-btn" data-act="more">Show more</button>` : ""}</div>`;
}

const opts = (list, cur, blank = "") => `<option value="">${esc(blank)}</option>` + list.map((v) => `<option value="${esc(v)}" ${String(cur ?? "") === v ? "selected" : ""}>${esc(v)}</option>`).join("");

function openEditDialog(row) {
  const cur = (k) => ci(row, k) ?? "";
  const rawItem = String(cur("item"));
  const itemList = LIB_ITEMS.includes(rawItem) ? LIB_ITEMS : [rawItem, ...LIB_ITEMS].filter(Boolean);
  const uvu = String(cur("unit_volume_uom"));
  const body = `
    <p class="sub">Barcode <code>${esc(barcodeOf(row))}</code> can't be changed here. Add a new item for a different barcode.</p>
    <div class="two-col">
      <label>Item category <select id="le-cat">${opts(LIB_CATEGORIES, cur("item_category"), "Choose…")}</select></label>
      <label>Item <select id="le-item">${opts(itemList, rawItem, "Choose…")}</select></label>
      <label>Make <input id="le-make" value="${esc(cur("make"))}" /></label>
      <label>Model <input id="le-model" value="${esc(cur("model"))}" /></label>
    </div>
    <label>Description <input id="le-desc" value="${esc(cur("description"))}" /></label>
    <div class="two-col">
      <label>Size <select id="le-size">${opts(SIZES, cur("size"))}</select></label>
      <label>Color <input id="le-color" value="${esc(cur("color"))}" /></label>
      <label>Count unit <select id="le-cu">${opts(COUNT_UNITS, cur("count_unit"))}</select></label>
      <label>Items in each pack <input id="le-pack" type="number" min="1" step="1" value="${esc(cur("units_per_pack"))}" /></label>
      <label>Volume of one item <input id="le-uv" type="number" min="0" step="any" value="${esc(cur("unit_volume"))}" /></label>
      <label>Volume unit <select id="le-uvu">${`<option value=""></option>` + VOLUME_UOMS.map((u) => `<option value="${esc(u.value)}" ${uvu === u.value ? "selected" : ""}>${esc(u.label)}</option>`).join("")}</select></label>
      <label>Quantity per pallet <input id="le-pallet" type="number" min="0" step="1" value="${esc(cur("qty_per_pallet"))}" /></label>
    </div>
    <p id="le-gal" class="hint"></p>`;
  const m = openModal({
    title: `Edit ${rawItem || "item"}`,
    body,
    buttons: [{ label: "Cancel" }, { label: "Save", kind: "primary", action: () => save() }],
  });
  const q = (id) => m.el.querySelector("#" + id);
  const gal = () => {
    const pack = PACK_UNITS.includes(q("le-cu").value) ? Math.round(Number(q("le-pack").value)) || 1 : 1;
    const per = gallonsPerVolume(Number(q("le-uv").value), q("le-uvu").value);
    q("le-gal").textContent = per > 0 ? `≈ ${Math.round(per * pack * 1000) / 1000} gallons per counted unit` : "";
  };
  m.el.addEventListener("input", gal); m.el.addEventListener("change", gal); gal();

  async function save() {
    const v = (id) => q(id).value.trim();
    if (!v("le-cat")) throw new Error("Choose an item category.");
    if (!v("le-item")) throw new Error("Choose the item.");
    if (!v("le-make")) throw new Error("Enter the make.");
    const cu = v("le-cu");
    const pack = PACK_UNITS.includes(cu) ? Math.round(Number(v("le-pack"))) || null : null;
    const uv = Number(v("le-uv")) || 0;
    const uom = v("le-uvu");
    const hasVol = uv > 0 && uom;
    const galPer = hasVol ? Math.round(gallonsPerVolume(uv, uom) * (pack || 1) * 1000) / 1000 : null;
    await updateLib(row, {
      item_category: v("le-cat"), item: v("le-item"), make: v("le-make"), model: v("le-model") || null,
      description: v("le-desc") || null,
      size: v("le-size") || null, color: v("le-color") || null,
      count_unit: cu || null, units_per_pack: pack,
      unit_volume: hasVol ? uv : null, unit_volume_uom: hasVol ? uom : null, gallons_per_count_unit: galPer,
      qty_per_pallet: v("le-pallet") ? Math.round(Number(v("le-pallet"))) : null,
    });
    toast("Saved.", "success");
    renderLib();
  }
  return m;
}

function openFlagDialog(row) {
  const bc = barcodeOf(row);
  const stock = S.balances.filter((b) => String(b.item_sku || "").trim() === bc).reduce((n, b) => n + onHand(b), 0);
  const m = openModal({
    title: "Flag for delete",
    body: `<p>${esc(ci(row, "item") || "")} · <code>${esc(bc)}</code>. The record is kept, but hidden from the list and item pickers until restored.</p>
      ${stock > 0 ? `<div class="banner banner-warn">${fmtNum(stock)} still on hand. Stock and history keep working.</div>` : ""}
      <label>Reason *<input id="lf-reason" placeholder="e.g. Duplicate of another barcode; wrong item" /></label>`,
    buttons: [
      { label: "Cancel" },
      { label: "Flag", kind: "danger", action: async () => {
        const reason = m.el.querySelector("#lf-reason").value.trim();
        if (!reason) throw new Error("Enter a reason.");
        await updateLib(row, { delete_flag: "Yes", delete_reason: reason.slice(0, 255), flagged_by: S.me.name, flagged_date: Date.now() });
        toast("Flagged. The record is kept.", "success");
        renderLib();
      } },
    ],
  });
  return m;
}

async function restore(row) {
  const ok = await confirmDialog({ title: "Restore this item?", message: `${ci(row, "item") || barcodeOf(row)} will show in the list and item pickers again.`, confirmLabel: "Restore" });
  if (!ok) return;
  try {
    await updateLib(row, { delete_flag: null, delete_reason: null, flagged_by: null, flagged_date: null });
    toast("Restored.", "success");
    renderLib();
  } catch (err) { toast(err.message, "error", 8000); }
}
