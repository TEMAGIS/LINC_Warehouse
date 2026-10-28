// ---------------------------------------------------------------------------
// Stock tab: every Inventory Balance row, searchable by location (Z1, Z1AA, ...) or item,
// with Move / To pick line on each row, plus the Receive / Move / Stage buttons.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { $, esc, debounce, fmtDateTime } from "./shared/util.js";
import { S, itemName, findLib, normSku } from "./state.js";
import { balanceCode, codeLabel, cleanScan, isPicklineRow, SEG_LABELS } from "./loc.js";
import { onHand } from "./data.js";
import { fmtNum, fmtGallons, gallonsFor, unitLabel } from "./units.js";
import { scanOnce } from "./scanner.js";
import { openReceive, openMove, openStage } from "./dialogs.js";
import { openAddToLibrary } from "./library.js";

const F = { q: "", scope: "all", page: 1 };

/** Rows after search + scope. A query that matches any location code is a LOCATION search
 *  (so "Z1" never turns into an item search); otherwise every word must appear in item / SKU / lot. */
export function filterRows(rows, { q = "", scope = "all" } = {}) {
  let out = rows.filter((r) => onHand(r) > 0);
  if (scope === "pick") out = out.filter(isPicklineRow);
  else if (scope === "storage") out = out.filter((r) => !isPicklineRow(r));
  const t = String(q || "").trim();
  if (!t) return out;
  const code = cleanScan(t);
  if (code && !/\s/.test(t) && out.some((r) => balanceCode(r).startsWith(code))) return out.filter((r) => balanceCode(r).startsWith(code));
  const ws = t.toLowerCase().split(/\s+/).filter(Boolean);
  return out.filter((r) => {
    const hay = `${itemName(r)} ${r.item_sku || ""} ${r.lot_number || ""} ${r.make || ""} ${r.model || ""}`.toLowerCase();
    return ws.every((w) => hay.includes(w));
  });
}

export function initStock() {
  const el = $("#screen-stock");
  el.addEventListener("input", debounce((e) => { if (e.target.id === "sk-q") { F.q = e.target.value; F.page = 1; renderRows(); } }, 150));
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "receive") openReceive();
    else if (a === "move") openMove();
    else if (a === "stage") openStage();
    else if (a === "addlib") openAddToLibrary({});
    else if (a === "scope") { F.scope = b.dataset.s; F.page = 1; renderStock(); }
    else if (a === "more") { F.page += 1; renderRows(); }
    else if (a === "rowmove") openMove({ from: b.dataset.code, sku: b.dataset.sku, lot: b.dataset.lot });
    else if (a === "rowstage") openStage({ sku: b.dataset.sku });
    else if (a === "scan") {
      const txt = await scanOnce("Scan a location or item barcode");
      if (txt) { F.q = txt; F.page = 1; $("#sk-q").value = txt; renderRows(); }
    }
  });
  S.render.stock = renderStock;
}

export function renderStock() {
  const el = $("#screen-stock");
  const all = S.balances.filter((r) => onHand(r) > 0);
  const total = all.reduce((n, r) => n + onHand(r), 0);
  const skus = new Set(all.map((r) => normSku(r.item_sku)));
  const locs = new Set(all.map(balanceCode));
  const pick = all.filter(isPicklineRow).reduce((n, r) => n + onHand(r), 0);
  const low = all.filter((r) => onHand(r) <= CONFIG.LOW_STOCK).length;
  const edit = S.canEdit;
  el.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="tile-n">${fmtNum(total)}</div><div class="tile-l">Units on hand</div></div>
      <div class="tile"><div class="tile-n">${fmtNum(skus.size)}</div><div class="tile-l">Item types</div></div>
      <div class="tile"><div class="tile-n">${fmtNum(locs.size)}</div><div class="tile-l">Locations in use</div></div>
      <div class="tile tile-info"><div class="tile-n">${fmtNum(pick)}</div><div class="tile-l">On the pick line</div></div>
      <div class="tile ${low ? "tile-warn" : ""}"><div class="tile-n">${fmtNum(low)}</div><div class="tile-l">Low-stock lines (≤ ${CONFIG.LOW_STOCK})</div></div>
    </div>
    <div class="toolbar">
      <input id="sk-q" type="search" placeholder="Location (Z1, Z1AA) or item / barcode" value="${esc(F.q)}" aria-label="Search stock" />
      <button type="button" data-act="scan">Scan</button>
      <div class="pill-row">${[["all", "All"], ["storage", "Storage"], ["pick", "Pick line"]]
        .map(([k, l]) => `<button type="button" class="pill ${F.scope === k ? "active" : ""}" data-act="scope" data-s="${k}">${l}</button>`).join("")}</div>
      <span class="spacer"></span>
      ${CONFIG.LOOKUP_URL ? `<a href="${esc(CONFIG.LOOKUP_URL)}" target="_blank" rel="noopener">Location lookup</a>` : ""}
      ${edit ? `<button type="button" data-act="addlib">Add to library</button>
        <button type="button" data-act="move">Move</button>
        <button type="button" data-act="stage">Stage to pick line</button>
        <button type="button" class="btn-primary" data-act="receive">Receive</button>` : ""}
    </div>
    <div id="sk-table"></div>`;
  renderRows();
}

function renderRows() {
  const host = $("#sk-table");
  if (!host) return;
  const rows = filterRows(S.balances, F).sort((a, b) => balanceCode(a).localeCompare(balanceCode(b), undefined, { numeric: true }) || itemName(a).localeCompare(itemName(b)));
  const shown = rows.slice(0, F.page * CONFIG.ROWS_PER_PAGE);
  const edit = S.canEdit;
  const body = shown.length
    ? shown.map((r) => {
        const code = balanceCode(r);
        const lib = findLib(r.item_sku);
        const q = onHand(r);
        const g = gallonsFor(lib, q);
        const pl = isPicklineRow(r);
        const segs = [r.zone, r.aisle, r.bay, r.level, r.position];
        const labels = r.zone ? SEG_LABELS : SEG_LABELS.slice(1);
        const segVals = r.zone ? segs : segs.slice(1);
        return `<tr>
          <td><span class="t">${esc(itemName(r))}</span><div class="sub">${esc(r.item_sku || "")}</div></td>
          <td><span class="mono">${esc(codeLabel(code))}</span>${pl ? ` <span class="tag">Pick line</span>` : ""}
            <div class="sub">${labels.map((l, i) => `${l} ${esc(segVals[i] ?? "")}`).join(" · ")}</div></td>
          <td>${esc(r.lot_number || "")}</td>
          <td class="num ${q <= CONFIG.LOW_STOCK ? "stock-low" : ""}">${fmtNum(q)}<div class="sub">${esc(unitLabel(lib, r.unit_of_measure))}</div>${g > 0 ? `<div class="sub">≈ ${fmtGallons(g)} gal</div>` : ""}</td>
          <td class="sub">${esc(fmtDateTime(r.last_update))}</td>
          <td class="row-actions">${edit ? `<button type="button" data-act="rowmove" data-code="${esc(code)}" data-sku="${esc(normSku(r.item_sku))}" data-lot="${esc(r.lot_number || "")}">Move</button>${pl ? "" : `<button type="button" data-act="rowstage" data-sku="${esc(normSku(r.item_sku))}">To pick line</button>`}` : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="empty">${S.balances.length ? "Nothing matches that search." : "No stock recorded yet."}</td></tr>`;
  host.innerHTML = `<div class="table-wrap tall"><table class="grid"><thead><tr><th>Item</th><th>Location</th><th>Lot</th><th class="num">On hand</th><th>Updated</th><th></th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="sub" style="margin:.5rem 0">${fmtNum(rows.length)} line(s)${shown.length < rows.length ? ` · showing ${fmtNum(shown.length)} <button type="button" class="link-btn" data-act="more">Show more</button>` : ""}</div>`;
}
