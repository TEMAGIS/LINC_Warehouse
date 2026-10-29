// ---------------------------------------------------------------------------
// Transactions tab: the most recent transactions, whoever or whatever wrote them
// (this app or the Survey123 field form), with their processing status and a Retry for
// anything still Pending or in Error.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { $, esc, debounce, fmtDateTime, toCSV, downloadText } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { S, itemName, itemParts, findLib } from "./state.js";
import { codeLabel, cleanScan } from "./loc.js";
import { fmtNum, fmtGallons, gallonsFor, unitLabel } from "./units.js";
import { queryAll } from "./shared/esri-client.js";
import { retryTransaction, voidTransaction } from "./txn.js";
import { loadBalances, loadTransactions } from "./data.js";
import { ownerName } from "./owners.js";

const F = { q: "", type: "", status: "", from: "", to: "", page: 1, remote: null };

const side = (t, p) => {
  const code = t[`${p}location_scan`];
  if (code) return codeLabel(code);
  return [t[`${p}zone`], t[`${p}row`], t[`${p}bay`], t[`${p}level`], t[`${p}position`]].filter((x) => x !== null && x !== undefined && x !== "").join("-");
};
const statusOf = (t) => String(t.processing_status || "").trim() || "Pending";
const stClass = (s) => (s === "Success" ? "st-ok" : s === "Error" ? "st-bad" : s === "Voided" ? "st-muted" : "st-pending");
const notApplied = (t) => { const s = statusOf(t); return s !== "Success" && s !== "Voided"; };

const dayStart = (d) => (d ? new Date(d + "T00:00:00").getTime() : null);
const dayEnd = (d) => (d ? new Date(d + "T23:59:59.999").getTime() : null);

export function filterTxns(rows, { q = "", type = "", status = "", from = "", to = "" } = {}) {
  const ws = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const t0 = dayStart(from), t1 = dayEnd(to);
  return rows.filter((t) => {
    if (type && t.transaction_type !== type) return false;
    if (status && statusOf(t) !== status) return false;
    if (t0 !== null || t1 !== null) {
      const when = Number(t.transaction_datetime) || 0;
      if (t0 !== null && when < t0) return false;
      if (t1 !== null && when > t1) return false;
    }
    if (!ws.length) return true;
    const hay = `${itemName(t)} ${t.item_sku || ""} ${t.lot || ""} ${side(t, "from_")} ${side(t, "to_")} ${t.performed_by || ""} ${t.shipment_id || ""} ${ownerName(t.property_owner)}`.toLowerCase();
    const codes = `${cleanScan(side(t, "from_"))} ${cleanScan(side(t, "to_"))}`.toLowerCase();
    return ws.every((w) => hay.includes(w) || codes.includes(w));
  });
}

export function initTransactions() {
  const el = $("#screen-txn");
  el.addEventListener("input", debounce((e) => { if (e.target.id === "tx-q") { F.q = e.target.value; F.page = 1; renderRows(); } }, 150));
  el.addEventListener("change", (e) => {
    if (e.target.id === "tx-type") F.type = e.target.value;
    else if (e.target.id === "tx-status") F.status = e.target.value;
    else if (e.target.id === "tx-from" || e.target.id === "tx-to") { F[e.target.id === "tx-from" ? "from" : "to"] = e.target.value; F.page = 1; return ensureRange(); }
    else return;
    F.page = 1;
    renderRows();
  });
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "more") { F.page += 1; renderRows(); }
    else if (b.dataset.act === "range") { setPreset(b.dataset.r); }
    else if (b.dataset.act === "csv-totals") exportTotals();
    else if (b.dataset.act === "csv") exportCsv();
    else if (b.dataset.act === "void") {
      const row = S.txns.find((t) => t.globalid === b.dataset.gid);
      if (!row) return;
      openModal({
        title: "Void this transaction?",
        body: `<p>${esc(itemName(row))} · ${esc(row.transaction_type)} · qty ${fmtNum(row.quantity)}. Voiding closes it out without changing inventory. It can't be retried afterwards.</p>
          <label>Reason *<input id="void-reason" placeholder="e.g. Bad quantity from the form; entered again correctly" /></label>`,
        buttons: [
          { label: "Cancel" },
          { label: "Void", kind: "danger", action: async (m) => {
            await voidTransaction(row, m.el.querySelector("#void-reason").value);
            toast("Voided.", "success");
            await loadTransactions();
            S.actions.refresh && S.actions.refresh();
          } },
        ],
      });
    }
    else if (b.dataset.act === "retry") {
      b.disabled = true;
      const row = S.txns.find((t) => t.globalid === b.dataset.gid);
      const r = row ? await retryTransaction(row) : { status: "pending", message: "Couldn't find that transaction." };
      toast(r.status === "applied" ? "Applied to inventory." : r.message, r.status === "applied" ? "success" : "error", 8000);
      await Promise.all([loadTransactions(), loadBalances()]);
      S.actions.refresh && S.actions.refresh();
    }
  });
  S.render.txn = renderTxns;
}

export function renderTxns() {
  const el = $("#screen-txn");
  const pending = S.txns.filter(notApplied).length;
  el.innerHTML = `
    <div class="toolbar">
      <input id="tx-q" type="search" placeholder="Item, barcode, location, person" value="${esc(F.q)}" aria-label="Search transactions" />
      <select id="tx-type" aria-label="Type"><option value="">All types</option>${["Receive", "Move", "Ship"].map((t) => `<option ${F.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
      <select id="tx-status" aria-label="Status"><option value="">All statuses</option>${["Success", "Pending", "Error", "Voided"].map((t) => `<option ${F.status === t ? "selected" : ""}>${t}</option>`).join("")}</select>
      ${pending ? `<span class="tag tag-restricted">${pending} not applied</span>` : ""}
      <span class="spacer"></span>
      <button type="button" data-act="csv">Export CSV</button>
    </div>
    <div class="toolbar tx-dates">
      <label class="inline">From <input type="date" id="tx-from" value="${esc(F.from)}" /></label>
      <label class="inline">To <input type="date" id="tx-to" value="${esc(F.to)}" /></label>
      <div class="pill-row" role="group" aria-label="Date range">${[["today", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["month", "This month"], ["lastmonth", "Last month"], ["all", "All dates"]]
        .map(([k, l]) => `<button type="button" class="pill ${presetOf() === k ? "active" : ""}" data-act="range" data-r="${k}">${l}</button>`).join("")}</div>
    </div>
    <div id="tx-summary"></div>
    <div id="tx-table"></div>`;
  renderRows();
}

// ---- date ranges and totals ---------------------------------------------------------------------
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function presetRange(k) {
  const now = new Date();
  const day = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return ymd(d); };
  if (k === "today") return { from: ymd(now), to: ymd(now) };
  if (k === "7") return { from: day(6), to: ymd(now) };
  if (k === "30") return { from: day(29), to: ymd(now) };
  if (k === "month") return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  if (k === "lastmonth") return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  return { from: "", to: "" };
}
const presetOf = () => ["today", "7", "30", "month", "lastmonth", "all"].find((k) => { const r = presetRange(k); return r.from === F.from && r.to === F.to; }) || "";
function setPreset(k) {
  Object.assign(F, presetRange(k));
  F.page = 1;
  renderTxns();
  ensureRange();
}

/**
 * The rows to show and total. Normally the newest transactions already loaded; but when more than that exist
 * and a date range is chosen, the range itself is fetched, so a month-end total is never missing older rows.
 */
const sourceRows = () => (F.remote && F.remote.rows ? F.remote.rows : S.txns);
async function ensureRange() {
  const t0 = dayStart(F.from), t1 = dayEnd(F.to);
  const needsServer = (t0 !== null || t1 !== null) && S.txns.length >= CONFIG.TXN_FETCH_LIMIT;
  if (!needsServer) { F.remote = null; return renderRows(); }
  const key = `${t0}|${t1}`;
  if (F.remote && F.remote.key === key && F.remote.rows) return renderRows();
  F.remote = { key, rows: null, loading: true };
  renderRows();
  const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const where = [t0 !== null && `transaction_datetime >= timestamp '${iso(t0)}'`, t1 !== null && `transaction_datetime <= timestamp '${iso(t1)}'`].filter(Boolean).join(" AND ");
  try {
    const rows = await queryAll(S.urls.txn, { where, pageSize: CONFIG.FETCH_PAGE_SIZE, oidField: (S.info.txn && S.info.txn.objectIdField) || "OBJECTID", orderByFields: "transaction_datetime DESC" });
    if (F.remote && F.remote.key === key) F.remote = { key, rows };
  } catch (err) {
    toast(`Couldn't load that date range, so the totals use only the newest ${CONFIG.TXN_FETCH_LIMIT} transactions: ${err.message}`, "error", 9000);
    F.remote = null;
  }
  renderRows();
}

/** Totals over rows: shipments, units, and one line per item name. Only applied (Success) transactions count unless a status is picked. */
export function totalsOf(rows, { status = "" } = {}) {
  const counted = status ? rows : rows.filter((t) => statusOf(t) === "Success");
  const items = new Map();
  const shipIds = new Set();
  let shipUnits = 0, recvUnits = 0, moves = 0, looseShips = 0;
  for (const t of counted) {
    const q = Number(t.quantity) || 0;
    const type = String(t.transaction_type || "");
    const lib = findLib(t.item_sku);
    const ip = itemParts(t, lib);
    const key = ip.generic ? `${ip.name.toLowerCase()}|${String(t.item_sku || "").trim()}` : ip.name.toLowerCase();
    const g = items.get(key) || { title: ip.generic ? ip.mm : ip.name, tag: ip.generic ? ip.name : "", recv: 0, ship: 0, moved: 0, gal: 0, ids: new Set() };
    if (type === "Ship") { g.ship += q; g.gal += gallonsFor(lib, q); shipUnits += q; if (t.shipment_id) { shipIds.add(t.shipment_id); g.ids.add(t.shipment_id); } else looseShips += 1; }
    else if (type === "Receive") { g.recv += q; recvUnits += q; }
    else if (type === "Move") { g.moved += q; moves += 1; }
    items.set(key, g);
  }
  const list = [...items.values()].sort((a, b) => b.ship - a.ship || b.recv - a.recv || a.title.localeCompare(b.title));
  return { counted: counted.length, skipped: rows.length - counted.length, shipments: shipIds.size, looseShips, shipUnits, recvUnits, moves, list };
}

function summaryHtml(rows) {
  const t = totalsOf(rows, F);
  const range = F.from || F.to ? `${F.from || "the beginning"} to ${F.to || "today"}` : "all loaded dates";
  const tile = (n, l, cls = "") => `<div class="tile ${cls}"><div class="tile-n">${fmtNum(n)}</div><div class="tile-l">${l}</div></div>`;
  const body = t.list.length ? t.list.map((g) => `<tr><td><span class="t">${esc(g.title)}</span>${g.tag ? ` <span class="tag">${esc(g.tag)}</span>` : ""}</td>
      <td class="num">${fmtNum(g.recv)}</td><td class="num">${fmtNum(g.ship)}${g.gal > 0 ? `<div class="sub">≈ ${fmtGallons(g.gal)} gal</div>` : ""}</td><td class="num">${fmtNum(g.ids.size)}</td><td class="num">${fmtNum(g.moved)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">Nothing to total.</td></tr>`;
  return `<details class="tx-totals" ${F.sumClosed ? "" : "open"}><summary><b>Totals</b> <span class="sub">for ${esc(range)}${F.type ? ` · ${esc(F.type)}` : ""}${F.q ? ` · “${esc(F.q)}”` : ""}</span></summary>
    <div class="tiles">${tile(t.shipments, "Shipments", "tile-info")}${tile(t.shipUnits, "Units shipped")}${tile(t.recvUnits, "Units received")}${tile(t.moves, "Moves")}${tile(t.counted, "Transactions counted")}</div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Item</th><th class="num">Received</th><th class="num">Shipped</th><th class="num">Shipments</th><th class="num">Moved</th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="sub" style="margin:.4rem 0">Counts applied (Success) transactions${t.skipped ? `; ${fmtNum(t.skipped)} not applied, voided or in error are left out` : ""}. Units are added as plain counts, so a case and a single bottle each count as 1.${t.looseShips ? ` ${fmtNum(t.looseShips)} shipped line(s) have no shipment number, so they aren't in the Shipments count.` : ""}
      <button type="button" class="link-btn" data-act="csv-totals">Download totals CSV</button></div></details>`;
}

function exportTotals() {
  const t = totalsOf(filterTxns(sourceRows(), F), F);
  const cols = [{ label: "Item", get: (g) => g.title }, { label: "Received", get: (g) => g.recv }, { label: "Shipped", get: (g) => g.ship }, { label: "Shipments", get: (g) => g.ids.size }, { label: "Moved", get: (g) => g.moved }, { label: "Gallons shipped", get: (g) => (g.gal > 0 ? Math.round(g.gal * 100) / 100 : "") }];
  downloadText(`linc_transaction_totals_${F.from || "start"}_to_${F.to || "now"}.csv`, toCSV(t.list, cols));
}

function renderRows() {
  const host = $("#tx-table");
  if (!host) return;
  const sum = $("#tx-summary");
  if (F.remote && F.remote.loading && !F.remote.rows) { if (sum) sum.innerHTML = `<div class="sub" style="margin:.4rem 0">Loading that date range…</div>`; host.innerHTML = ""; return; }
  const rows = filterTxns(sourceRows(), F);
  if (sum) { sum.innerHTML = summaryHtml(rows); const d = sum.querySelector("details"); if (d) d.addEventListener("toggle", () => { F.sumClosed = !d.open; }); }
  const shown = rows.slice(0, F.page * CONFIG.ROWS_PER_PAGE);
  const body = shown.length
    ? shown.map((t) => {
        const st = statusOf(t);
        const lib = findLib(t.item_sku);
        const type = String(t.transaction_type || "");
        const cls = type === "Ship" ? "txn-issue" : type === "Receive" ? "txn-receive" : "";
        return `<tr>
          <td class="sub">${esc(fmtDateTime(t.transaction_datetime))}</td>
          <td><span class="txn-type ${cls}">${esc(type)}</span></td>
          <td><span class="t">${esc(itemName(t))}</span><div class="sub">${esc(t.item_sku || "")}${t.lot ? " · lot " + esc(t.lot) : ""}${t.property_owner ? ` · <span class="owner-tag">${esc(ownerName(t.property_owner))}</span>` : ""}</div></td>
          <td class="num">${fmtNum(t.quantity)}<div class="sub">${esc(unitLabel(lib, t.unit_of_measure))}</div></td>
          <td class="mono">${esc(side(t, "from_"))}</td><td class="mono">${esc(side(t, "to_"))}</td>
          <td class="sub">${esc(t.performed_by || "")}${t.shipment_id ? `<div>${esc(t.shipment_id)}</div>` : ""}</td>
          <td><span class="status-pill ${stClass(st)}">${esc(st)}</span>${t.processing_error ? `<div class="sub">${esc(t.processing_error)}</div>` : ""}
            ${S.canEdit && st !== "Success" && st !== "Voided" && t.globalid ? `<button type="button" class="link-btn" data-act="retry" data-gid="${esc(t.globalid)}">Retry</button>` : ""}
            ${S.isAdmin && S.canEdit && st !== "Success" && st !== "Voided" && t.globalid ? `<button type="button" class="link-btn" data-act="void" data-gid="${esc(t.globalid)}">Void</button>` : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" class="empty">No transactions match.</td></tr>`;
  host.innerHTML = `<div class="table-wrap tall"><table class="grid"><thead><tr><th>When</th><th>Type</th><th>Item</th><th class="num">Qty</th><th>From</th><th>To</th><th>By</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="sub" style="margin:.5rem 0">${fmtNum(rows.length)} transaction(s)${S.txns.length >= CONFIG.TXN_FETCH_LIMIT && !(F.remote && F.remote.rows) ? ` (newest ${CONFIG.TXN_FETCH_LIMIT} loaded; pick dates to total further back)` : ""}${shown.length < rows.length ? ` · showing ${fmtNum(shown.length)} <button type="button" class="link-btn" data-act="more">Show more</button>` : ""}</div>`;
}

function exportCsv() {
  const rows = filterTxns(sourceRows(), F);
  const cols = [
    { label: "When", get: (t) => (t.transaction_datetime ? new Date(Number(t.transaction_datetime)).toISOString() : "") },
    { label: "Type", key: "transaction_type" },
    { label: "Item", get: (t) => itemName(t) },
    { label: "Barcode", key: "item_sku" },
    { label: "Quantity", key: "quantity" },
    { label: "Unit", key: "unit_of_measure" },
    { label: "Lot", key: "lot" },
    { label: "Property owner", get: (t) => ownerName(t.property_owner) },
    { label: "From", get: (t) => side(t, "from_") },
    { label: "To", get: (t) => side(t, "to_") },
    { label: "By", key: "performed_by" },
    { label: "Shipment", key: "shipment_id" },
    { label: "Status", get: (t) => statusOf(t) },
  ];
  downloadText(`linc_transactions_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows, cols));
}
