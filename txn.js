// ---------------------------------------------------------------------------
// Writing transactions:
//   1. add a row to the Transactions layer (the same fields the Survey123 form fills),
//   2. apply it to Inventory Balance (balance.js, in the browser; all-or-nothing) and stamp
//      processing_status on the row. (APPLY_MODE "webhook" calls the Lambda instead.)
//   3. reload balances.
// Lines are written ONE AT A TIME: two lines can touch the same balance row (e.g. staging
// from two shelves to one pick-line row), and applying reads the row, then writes it.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { applyEdits } from "./shared/esri-client.js";
import { S, findLib, sameLot } from "./state.js";
import { ci, uomForTxn } from "./units.js";
import { txnLocationAttrs, balanceCode, isPicklineCode, codeLabel } from "./loc.js";
import { loadBalances, loadTransactions } from "./data.js";
import { applyToBalance } from "./balance.js";
import { ownersActive, canActOn, isScoped, sameOwner, ownerName, myOwnerCodes, receiveChoices } from "./owners.js";

export const TXN_TYPES = ["Receive", "Move", "Ship"];

/**
 * line = { type: "Receive"|"Move"|"Ship", sku, qty, lot?, from?, to?, extra? }
 * `from` / `to` are location scan codes. Receive needs `to`; Ship needs `from`; Move both.
 */
export function buildTxnAttrs(line) {
  const sku = String(line.sku || "").trim();
  const lib = findLib(sku);
  const a = {
    site: CONFIG.SITE,
    transaction_type: line.type,
    item_sku: sku,
    category: lib ? ci(lib, "item_category") ?? "" : "",
    item: lib ? String(ci(lib, "item") ?? "").trim() : line.name || "",
    make: lib ? ci(lib, "make") ?? "" : "",
    model: lib ? ci(lib, "model") ?? "" : "",
    description: lib ? ci(lib, "description") ?? "" : "",
    quantity: Math.round(Number(line.qty)),
    unit_of_measure: lib ? uomForTxn(lib) : line.unit || "",
    lot: line.lot ? String(line.lot).trim() : "",
    ...(ownersActive() ? { property_owner: line.owner ? String(line.owner).trim() : "" } : {}),
    transaction_datetime: Date.now(),
    firstname: S.me.first,
    lastname: S.me.last,
    performed_by: S.me.name,
    processing_status: "Pending",
    ...(line.extra || {}),
  };
  if (lib) {
    const w = ci(lib, "weight"), d = ci(lib, "dimensions");
    if (w != null && w !== "") a.weight = w;
    if (d != null && d !== "") a.dimensions = d;
  }
  if (line.type === "Move" || line.type === "Ship") Object.assign(a, strip(txnLocationAttrs(line.from, "from_")));
  if (line.type === "Move" || line.type === "Receive") Object.assign(a, strip(txnLocationAttrs(line.to, "to_")));
  return a;
}

const strip = (o) => { const c = { ...o }; delete c._label; return c; };

/** Keeps only keys that exist on the live Transactions layer (case-insensitive), using the layer's own spelling. */
export function fitToLayer(attrs, info) {
  if (!info || !info.fields || !info.fields.length) return attrs;
  const names = new Map(info.fields.map((f) => [f.name.toLowerCase(), f.name]));
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    const real = names.get(k.toLowerCase());
    if (real && v !== undefined) out[real] = v;
  }
  return out;
}

// ---- pre-checks (the Lambda re-checks everything; this just gives a friendly message first) -------------------

export function validateLines(lines) {
  const errors = [];
  const running = new Map(); // sku|code|lot -> quantity still available after earlier lines
  const owned = ownersActive();
  const key = (sku, code, lot, owner) => `${String(sku).trim()}|${code}|${String(lot || "").trim()}|${owned ? String(owner || "").trim().toLowerCase() : ""}`;
  const startQty = (sku, code, lot, owner) => {
    const r = S.balances.find((b) => String(b.item_sku || "").trim() === String(sku).trim() && balanceCode(b) === code && sameLot(b.lot_number, lot) && (!owned || sameOwner(b.property_owner, owner)));
    return r ? Number(r.quantity_on_hand) || 0 : 0;
  };
  lines.forEach((l, i) => {
    const n = lines.length > 1 ? `Line ${i + 1}: ` : "";
    if (!l.sku) errors.push(`${n}scan or choose an item.`);
    if (owned) {
      if (l.type === "Receive" && !l.owner && isScoped()) errors.push(`${n}choose the property owner.`);
      if (l.type === "Receive" && l.owner && !receiveChoices().some((o) => sameOwner(o.code, l.owner))) errors.push(`${n}you can't receive stock for that property owner.`);
      if (l.type !== "Receive" && !canActOn(l.owner)) errors.push(`${n}that stock belongs to ${l.owner ? ownerName(l.owner) : "no group"}. You can only handle stock owned by ${myOwnerCodes().map(ownerName).join(", ")}.`);
    }
    if (!(Number(l.qty) > 0) || Math.round(Number(l.qty)) !== Number(l.qty)) errors.push(`${n}quantity must be a whole number above 0.`);
    if ((l.type === "Receive" || l.type === "Move") && !l.to) errors.push(`${n}choose the destination location.`);
    if ((l.type === "Move" || l.type === "Ship") && !l.from) errors.push(`${n}choose the source location.`);
    if (l.type === "Ship" && l.from && !isPicklineCode(l.from)) errors.push(`${n}ships must come from the pick line. Stage it there first.`);
    if (l.type === "Move" && l.from && l.to && l.from === l.to) errors.push(`${n}from and to are the same location.`);
    if ((l.type === "Move" || l.type === "Ship") && l.from && l.sku && Number(l.qty) > 0) {
      const k = key(l.sku, l.from, l.lot, l.owner);
      const have = running.has(k) ? running.get(k) : startQty(l.sku, l.from, l.lot, l.owner);
      if (Number(l.qty) > have) errors.push(`${n}only ${have} on hand at ${codeLabel(l.from)} — can't take ${l.qty}.`);
      running.set(k, have - Number(l.qty));
    }
    if ((l.type === "Move" || l.type === "Receive") && l.to) {
      const k = key(l.sku, l.to, l.lot, l.owner);
      const have = running.has(k) ? running.get(k) : startQty(l.sku, l.to, l.lot, l.owner);
      running.set(k, have + Number(l.qty));
    }
  });
  return errors;
}

// ---- applying (browser by default, webhook optional) -------------------------------------------------

const attrsFull = (line) => buildTxnAttrs(line);

/** Writes processing_status etc. back onto the transaction row (only fields the layer has). */
async function stampTxn(oid, { ok, message, gids }) {
  if (oid === null || oid === undefined) return;
  const key = (S.info.txn && S.info.txn.objectIdField) || "OBJECTID";
  const attrs = fitToLayer({
    processing_status: ok ? "Success" : "Error",
    processed_at: Date.now(),
    processing_error: ok ? "" : String(message || "").slice(0, 250),
    inventory_balance_gids: (gids || []).join(","),
  }, S.info.txn);
  try {
    await applyEdits(S.urls.txn, { updates: [{ attributes: { ...attrs, [key]: oid } }] });
  } catch (err) {
    console.warn("Couldn't write processing_status back:", err); // balance is already right; the idempotency check covers a retry
  }
}

/** Applies one saved transaction. Returns {status: "applied"|"rejected"|"pending", message}. */
async function applyOne(fullAttrs, oid, gid) {
  if (CONFIG.APPLY_MODE === "webhook") return gid ? kickWebhook(gid) : { status: "pending", message: "Saved (no id returned to confirm)." };
  const r = await applyToBalance(fullAttrs);
  await stampTxn(oid, r);
  return r.ok ? { status: "applied", message: r.message } : { status: "rejected", message: r.message };
}

/** Re-applies a Pending / Error transaction row from the Transactions tab. */
export async function retryTransaction(row) {
  if (CONFIG.APPLY_MODE === "webhook") return kickWebhook(row.globalid);
  const r = await applyToBalance(row);
  await stampTxn(row._oid, r);
  return r.ok ? { status: "applied", message: r.message } : { status: "rejected", message: r.message };
}

/** Administrator-only: closes out a transaction that can never be applied. Inventory is not touched. */
export async function voidTransaction(row, reason) {
  const why = String(reason || "").trim();
  if (!why) throw new Error("Enter a reason.");
  if (String(row.processing_status || "") === "Success") throw new Error("That transaction was already applied; it can't be voided.");
  const key = (S.info.txn && S.info.txn.objectIdField) || "OBJECTID";
  const attrs = fitToLayer({
    processing_status: "Voided",
    processed_at: Date.now(),
    processing_error: `Voided by ${S.me.name}: ${why}`.slice(0, 250),
  }, S.info.txn);
  await applyEdits(S.urls.txn, { updates: [{ attributes: { ...attrs, [key]: row._oid } }] });
}

// ---- webhook (only when APPLY_MODE is "webhook") ---------------------------------------------------------

const bareGid = (g) => String(g || "").replace(/[{}]/g, "").toLowerCase();

/** Asks the Lambda to apply one transaction. Returns {status:"applied"|"rejected"|"pending", message}. */
export async function kickWebhook(gid) {
  if (!CONFIG.WEBHOOK_URL) return { status: "pending", message: "No webhook configured — it will apply when reconcile runs." };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    // text/plain keeps this a "simple" request (no CORS preflight); the Lambda parses the body as JSON regardless.
    const res = await fetch(CONFIG.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ eventType: "addData", feature: { attributes: { globalid: bareGid(gid) } } }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { status: "pending", message: body.error || `Webhook answered ${res.status}` };
    if (body.status === "rejected") return { status: "rejected", message: body.reason || "Rejected" };
    return { status: "applied", message: body.status || "applied" };
  } catch (err) {
    return { status: "pending", message: `Couldn't reach the webhook (${err.name === "AbortError" ? "timed out" : err.message}). The transaction is saved and will apply when reconcile runs.` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes the lines one by one. Stops at the first line that is rejected or fails, so a
 * half-finished batch is clear. Returns [{line, ok, status, message, gid}] for the lines attempted.
 */
export async function submitTransactions(lines, { onProgress = () => {} } = {}) {
  const errs = validateLines(lines);
  if (errs.length) throw new Error(errs.join("\n"));
  if (!S.canEdit) throw new Error("Your account can view inventory but can't add transactions.");
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    onProgress(i, lines.length, line);
    const attrs = fitToLayer(attrsFull(line), S.info.txn);
    let gid = "";
    let oid = null;
    try {
      const resp = await applyEdits(S.urls.txn, { adds: [{ attributes: attrs }] });
      gid = (resp.addResults && resp.addResults[0] && resp.addResults[0].globalId) || "";
      oid = resp.addResults && resp.addResults[0] && resp.addResults[0].objectId;
    } catch (err) {
      results.push({ line, ok: false, status: "error", message: err.message, gid });
      break;
    }
    const k = await applyOne({ ...attrsFull(line), globalid: gid }, oid, gid);
    const ok = k.status !== "rejected";
    results.push({ line, ok, status: k.status, message: k.message, gid });
    if (k.status === "pending") S.pending.push({ gid: bareGid(gid), at: Date.now(), line });
    if (!ok) break;
  }
  try { await Promise.all([loadBalances(), loadTransactions()]); } catch (err) { console.warn("Reload after submit failed:", err); }
  return results;
}

/** One-line summary of submitTransactions results for a toast. */
export function summarizeResults(results, total) {
  const applied = results.filter((r) => r.status === "applied").length;
  const pending = results.filter((r) => r.status === "pending").length;
  const bad = results.find((r) => !r.ok);
  if (bad) return { kind: "error", text: `${applied} of ${total} saved. Stopped: ${bad.message}` };
  if (pending) return { kind: "info", text: `${results.length} saved. ${pending} waiting to be applied to inventory.` };
  return { kind: "success", text: results.length === 1 ? "Saved and applied." : `${results.length} lines saved and applied.` };
}
