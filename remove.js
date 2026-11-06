// ---------------------------------------------------------------------------
// Taking stock out without shipping it.
//   * Adjust (write-off): staff who can handle the stock. Records an "Adjust" transaction with a
//     reason (damaged, expired, lost, count correction...) and takes the quantity off that shelf.
//     Full audit trail, same apply rules as everything else (balance.js).
//   * Delete (administrators): for test / fake stock that should never have existed. Deletes the
//     Inventory Balance row outright and, if ticked, marks the transactions that put it there as
//     Voided so they drop out of totals. Not logged as a transaction.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { esc } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { applyEdits } from "./shared/esri-client.js";
import { S, itemName, itemParts, findLib, normSku, sameLot } from "./state.js";
import { onHand, loadBalances, loadTransactions } from "./data.js";
import { balanceCode, codeLabel, cleanScan, pad2, parseCode } from "./loc.js";
import { submitTransactions, summarizeResults, fitToLayer } from "./txn.js";
import { fmtNum, unitLabel } from "./units.js";
import { ownersActive, sameOwner, ownerName } from "./owners.js";
import { plannedQty } from "./shipments.js";

export const ADJUST_REASONS = ["Damaged", "Expired", "Lost / missing", "Count correction", "Entered by mistake / test", "Other"];

const hasTxnField = (name) => ((S.info.txn && S.info.txn.fields) || []).some((f) => f.name.toLowerCase() === name);
const refresh = () => S.actions.refresh && S.actions.refresh();

const rowSummary = (row) => {
  const lib = findLib(row.item_sku);
  const p = itemParts(row, lib);
  return `<div><strong>${esc(p.title)}</strong>${p.generic ? ` <span class="tag">${esc(p.name)}</span>` : ""}<div class="sub">${esc(row.item_sku || "")} · ${esc(codeLabel(balanceCode(row)))}${row.lot_number ? " · lot " + esc(row.lot_number) : ""}${ownersActive() && row.property_owner ? " · " + esc(ownerName(row.property_owner)) : ""} · <b>${fmtNum(onHand(row))}</b> ${esc(unitLabel(lib, row.unit_of_measure))} on hand</div></div>`;
};

const promisedFor = (row) => plannedQty(row.item_sku, balanceCode(row), row.lot_number, ownersActive() ? { owner: String(row.property_owner || "") } : {});

// ---- Adjust (write-off) ------------------------------------------------------------------------

export function openAdjust(row) {
  if (!row) return;
  const have = onHand(row);
  const code = balanceCode(row);
  const promised = promisedFor(row);
  const badCode = !parseCode(code);
  const webhook = CONFIG.APPLY_MODE === "webhook";
  openModal({
    title: "Adjust stock (write off)",
    body: `${rowSummary(row)}
      ${badCode ? `<div class="banner banner-warn"><div>This row's location (${esc(code || "blank")}) isn't a valid 8 or 10 character code, so it can't be adjusted with a transaction. An administrator can Delete it instead.</div></div>` : ""}
      ${webhook ? `<div class="banner banner-warn"><div>APPLY_MODE is "webhook" and the Lambda doesn't know Adjust transactions. Switch to "browser" in config.js to use this.</div></div>` : ""}
      ${promised > 0 ? `<div class="banner banner-warn"><div>${fmtNum(promised)} of this is promised to open shipment plans.</div></div>` : ""}
      <label>Quantity to remove *<input id="adj-qty" class="count-input" type="number" min="1" max="${have}" step="1" value="${have}" inputmode="numeric" /></label>
      <label>Reason *<select id="adj-why">${ADJUST_REASONS.map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
      <label>Details<input id="adj-note" maxlength="200" placeholder="e.g. Pallet crushed by forklift; 3 cases leaking" /></label>
      <p class="hint">Records an <b>Adjust</b> transaction and takes this quantity off the shelf. It shows on the Transactions tab with the reason. To add stock you found, use Receive.</p>
      ${hasTxnField("adjust_reason") ? "" : `<p class="hint">The Transactions layer has no <code>adjust_reason</code> field yet, so the reason won't be saved. Settings → Add all missing fields adds it.</p>`}`,
    buttons: [{ label: "Cancel" }, { label: "Write off", kind: "danger", action: async (m) => {
      if (badCode || webhook) throw new Error("This row can't be adjusted. See the note above.");
      const qty = Number(m.el.querySelector("#adj-qty").value);
      if (!Number.isInteger(qty) || qty < 1) throw new Error("Quantity must be a whole number above 0.");
      if (qty > have) throw new Error(`Only ${have} on hand.`);
      const why = m.el.querySelector("#adj-why").value;
      const note = m.el.querySelector("#adj-note").value.trim();
      if (why === "Other" && !note) throw new Error("Add details for “Other”.");
      const reason = (note ? `${why}: ${note}` : why).slice(0, 255);
      const results = await submitTransactions([{
        type: "Adjust", sku: normSku(row.item_sku), name: itemName(row), qty, lot: row.lot_number || "", from: code,
        owner: row.property_owner || "", extra: { adjust_reason: reason },
      }]);
      const s = summarizeResults(results, 1);
      toast(s.kind === "success" ? `Wrote off ${fmtNum(qty)}.` : s.text, s.kind, s.kind === "error" ? 9000 : 4500);
      refresh();
      if (results.some((r) => !r.ok)) throw new Error(s.text);
    } }],
  });
}

// ---- Delete (administrators, test / fake stock) ------------------------------------------------

/** A transaction side's location code ("from_" / "to_"), same normalising as balanceCode. */
function txnCode(t, p) {
  const scan = cleanScan(t[`${p}location_scan`]);
  if (scan) return scan;
  return [t[`${p}zone`], t[`${p}row`], t[`${p}bay`], t[`${p}level`], t[`${p}position`]].map(pad2).filter((v) => v !== "").join("").toUpperCase();
}

/** Applied transactions (in the loaded history) that touched this row's item + shelf + lot (+ owner). */
export function txnsForRow(row) {
  const code = balanceCode(row);
  const sku = normSku(row.item_sku);
  return S.txns.filter((t) => normSku(t.item_sku) === sku
    && String(t.processing_status || "") === "Success"
    && sameLot(t.lot, row.lot_number)
    && (!ownersActive() || sameOwner(t.property_owner, row.property_owner))
    && (txnCode(t, "to_") === code || txnCode(t, "from_") === code));
}

/** Deletes the balance row; optionally voids `txns`. Returns the number voided. */
export async function deleteStockRow(row, { txns = [], reason = "" } = {}) {
  const why = String(reason || "").trim();
  if (!why) throw new Error("Enter a reason.");
  if (row._oid === undefined || row._oid === null) throw new Error("This row has no object id; reload and try again.");
  await applyEdits(S.urls.bal, { deletes: [row._oid] });
  if (!txns.length) return 0;
  const key = (S.info.txn && S.info.txn.objectIdField) || "OBJECTID";
  const updates = txns.map((t) => ({ attributes: { ...fitToLayer({
    processing_status: "Voided",
    processing_error: `Voided by ${S.me.name} (stock deleted): ${why}`.slice(0, 250),
  }, S.info.txn), [key]: t._oid } }));
  try {
    await applyEdits(S.urls.txn, { updates });
  } catch (err) {
    throw new Error(`The stock row was deleted, but marking its transactions Voided failed: ${err.message}. Void them from the Transactions tab.`);
  }
  return txns.length;
}

export function openDeleteStock(row) {
  if (!row || !S.isAdmin) return;
  const txns = txnsForRow(row);
  const promised = promisedFor(row);
  const moved = txns.some((t) => t.transaction_type === "Move" && txnCode(t, "from_") === balanceCode(row));
  const list = txns.slice(0, 8).map((t) => `<li><b>${esc(t.transaction_type)}</b> ${fmtNum(t.quantity)} · ${esc(new Date(Number(t.transaction_datetime) || 0).toLocaleString())} · ${esc(t.performed_by || "")}</li>`).join("");
  openModal({
    title: "Delete stock row",
    body: `${rowSummary(row)}
      <div class="banner banner-warn"><div>
        <div><b>Only for stock that was never really there</b> (a test, or entered by mistake).</div>
        <div style="margin-top:.35rem">This removes the row from Inventory Balance with no transaction record. For real stock that's damaged, lost or miscounted, use <b>Adjust</b> instead.</div>
      </div></div>
      ${promised > 0 ? `<div class="banner banner-warn"><div>${fmtNum(promised)} of this is promised to open shipment plans. Remove it from those plans too.</div></div>` : ""}
      <label>Reason *<input id="del-why" maxlength="200" placeholder="e.g. Test receive while setting up the app" /></label>
      ${txns.length ? `<label class="check"><input type="checkbox" id="del-void" checked /> <span>Also mark the ${txns.length} transaction${txns.length === 1 ? "" : "s"} that touched it as <b>Voided</b> (they drop out of totals)</span></label>
        <ul class="sub">${list}${txns.length > 8 ? `<li>…and ${txns.length - 8} more</li>` : ""}</ul>
        ${moved ? `<p class="hint">Some of this was moved to another shelf. Voiding the Move doesn't change that other shelf; delete or adjust it there too.</p>` : ""}` : `<p class="hint">No applied transactions for it in the loaded history.</p>`}`,
    buttons: [{ label: "Cancel" }, { label: "Delete", kind: "danger", action: async (m) => {
      const reason = m.el.querySelector("#del-why").value;
      const voidIt = !!(m.el.querySelector("#del-void") && m.el.querySelector("#del-void").checked);
      const n = await deleteStockRow(row, { txns: voidIt ? txns : [], reason });
      toast(`Deleted${n ? `; ${n} transaction${n === 1 ? "" : "s"} voided` : ""}.`, "success");
      await Promise.all([loadBalances(), loadTransactions()]).catch((err) => console.warn("Reload after delete failed:", err));
      refresh();
    } }],
  });
}
