// ---------------------------------------------------------------------------
// Transactions tab: the most recent transactions, whoever or whatever wrote them
// (this app or the Survey123 field form), with their processing status and a Retry for
// anything still Pending or in Error.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { $, esc, debounce, fmtDateTime, toCSV, downloadText } from "./shared/util.js";
import { toast, openModal } from "./shared/ui.js";
import { S, itemName, findLib } from "./state.js";
import { codeLabel, cleanScan } from "./loc.js";
import { fmtNum, unitLabel } from "./units.js";
import { retryTransaction, voidTransaction } from "./txn.js";
import { loadBalances, loadTransactions } from "./data.js";

const F = { q: "", type: "", status: "", page: 1 };

const side = (t, p) => {
  const code = t[`${p}location_scan`];
  if (code) return codeLabel(code);
  return [t[`${p}zone`], t[`${p}row`], t[`${p}bay`], t[`${p}level`], t[`${p}position`]].filter((x) => x !== null && x !== undefined && x !== "").join("-");
};
const statusOf = (t) => String(t.processing_status || "").trim() || "Pending";
const stClass = (s) => (s === "Success" ? "st-ok" : s === "Error" ? "st-bad" : s === "Voided" ? "st-muted" : "st-pending");
const notApplied = (t) => { const s = statusOf(t); return s !== "Success" && s !== "Voided"; };

export function filterTxns(rows, { q = "", type = "", status = "" } = {}) {
  const ws = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((t) => {
    if (type && t.transaction_type !== type) return false;
    if (status && statusOf(t) !== status) return false;
    if (!ws.length) return true;
    const hay = `${itemName(t)} ${t.item_sku || ""} ${t.lot || ""} ${side(t, "from_")} ${side(t, "to_")} ${t.performed_by || ""} ${t.shipment_id || ""}`.toLowerCase();
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
    else return;
    F.page = 1;
    renderRows();
  });
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "more") { F.page += 1; renderRows(); }
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
    <div id="tx-table"></div>`;
  renderRows();
}

function renderRows() {
  const host = $("#tx-table");
  if (!host) return;
  const rows = filterTxns(S.txns, F);
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
          <td><span class="t">${esc(itemName(t))}</span><div class="sub">${esc(t.item_sku || "")}${t.lot ? " · lot " + esc(t.lot) : ""}</div></td>
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
    <div class="sub" style="margin:.5rem 0">${fmtNum(rows.length)} transaction(s)${S.txns.length >= CONFIG.TXN_FETCH_LIMIT ? ` (newest ${CONFIG.TXN_FETCH_LIMIT} loaded)` : ""}${shown.length < rows.length ? ` · showing ${fmtNum(shown.length)} <button type="button" class="link-btn" data-act="more">Show more</button>` : ""}</div>`;
}

function exportCsv() {
  const rows = filterTxns(S.txns, F);
  const cols = [
    { label: "When", get: (t) => (t.transaction_datetime ? new Date(Number(t.transaction_datetime)).toISOString() : "") },
    { label: "Type", key: "transaction_type" },
    { label: "Item", get: (t) => itemName(t) },
    { label: "Barcode", key: "item_sku" },
    { label: "Quantity", key: "quantity" },
    { label: "Unit", key: "unit_of_measure" },
    { label: "Lot", key: "lot" },
    { label: "From", get: (t) => side(t, "from_") },
    { label: "To", get: (t) => side(t, "to_") },
    { label: "By", key: "performed_by" },
    { label: "Shipment", key: "shipment_id" },
    { label: "Status", get: (t) => statusOf(t) },
  ];
  downloadText(`linc_transactions_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows, cols));
}
