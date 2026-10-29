// ---------------------------------------------------------------------------
// Loading the three data layers (Inventory Balance, Transactions, Barcode Library) and
// working out who this person is: warehouse staff (can add transactions) and/or
// Inventory Administrator (Users layer).
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { esriRequest, getLayerInfo, itemServiceUrl, queryAll, sqlStr } from "./shared/esri-client.js";
import { S, indexLibrary } from "./state.js";
import { balanceCode } from "./loc.js";

/** Layer/table URL for an item. Tables first (Survey123 tables), then layers. */
export async function serviceLayerUrl(itemId, { preferLayers = false } = {}) {
  const svc = await itemServiceUrl(itemId);
  const meta = await esriRequest(svc, {}, { method: "GET" });
  const order = preferLayers ? [meta.layers, meta.tables] : [meta.tables, meta.layers];
  for (const group of order) if (group && group.length) return `${svc}/${group[0].id}`;
  return `${svc}/0`;
}

const can = (info, word) => String((info && info.raw && info.raw.capabilities) || "").toLowerCase().includes(word);

const NAMES = { bal: "Inventory Balance", txn: "Transactions", lib: "Barcode Library" };

/** Opens the editable item; if this account can't, the view-only copy (read-only app). Throws a detailed error if neither opens. */
async function openLayer(key, editableId, viewId, opts) {
  try {
    const url = await serviceLayerUrl(editableId, opts);
    S.itemUsed[key] = editableId; delete S.usingView[key];
    return url;
  } catch (err) {
    if (err && (err.code === 498 || err.code === 499)) throw err;
    if (viewId && viewId !== editableId) {
      try {
        const url = await serviceLayerUrl(viewId, opts);
        S.itemUsed[key] = viewId; S.usingView[key] = err.message;
        return url;
      } catch (err2) { err2.detail = `${NAMES[key]}: the editable item says “${err.message}”, and the view-only copy says “${err2.message}”.`; throw err2; }
    }
    err.detail = `${NAMES[key]}: ${err.message}`;
    throw err;
  }
}

export async function resolveLayers() {
  const ids = CONFIG.ITEM_IDS;
  const views = CONFIG.VIEW_ITEM_IDS || {};
  const results = await Promise.allSettled([
    openLayer("bal", ids.balance, views.balance, {}),
    openLayer("txn", ids.transactions, views.transactions, {}),
    openLayer("lib", ids.library, views.library, { preferLayers: true }),
  ]);
  const bad = results.filter((r) => r.status === "rejected");
  if (bad.length) {
    const e = bad[0].reason;
    e.detail = bad.map((r) => r.reason.detail || r.reason.message).join(" ");
    throw e;
  }
  const [bal, txn, lib] = results.map((r) => r.value);
  S.urls = { ...S.urls, bal, txn, lib };
  const [ib, it, il] = await Promise.all([getLayerInfo(bal), getLayerInfo(txn), getLayerInfo(lib)]);
  S.info = { ...S.info, bal: ib, txn: it, lib: il };
  // Warehouse staff = can add Transactions AND (in browser mode) edit Inventory Balance.
  // (Layer capabilities reflect what this account may do.)
  S.canEditBalance = can(ib, "update") || can(ib, "editing");
  S.layerCanEdit = can(it, "create") && can(it, "editing") && (CONFIG.APPLY_MODE === "webhook" || S.canEditBalance);
  S.canEdit = S.layerCanEdit; // app.js narrows this by the person's role
}

export async function loadBalances() {
  const oid = S.info.bal ? S.info.bal.objectIdField : "OBJECTID";
  S.balances = await queryAll(S.urls.bal, { pageSize: CONFIG.FETCH_PAGE_SIZE, oidField: oid });
}

export async function loadTransactions() {
  const oid = S.info.txn ? S.info.txn.objectIdField : "OBJECTID";
  const data = await esriRequest(`${S.urls.txn}/query`, {
    where: "1=1", outFields: "*", returnGeometry: "false",
    orderByFields: "transaction_datetime DESC", resultRecordCount: String(CONFIG.TXN_FETCH_LIMIT),
  });
  const oidName = data.objectIdFieldName || oid;
  S.txns = (data.features || []).map((f) => ({ ...f.attributes, _oid: f.attributes[oidName] }));
}

export async function loadLibrary() {
  const oid = S.info.lib ? S.info.lib.objectIdField : "OBJECTID";
  indexLibrary(await queryAll(S.urls.lib, { pageSize: CONFIG.FETCH_PAGE_SIZE, oidField: oid }));
}

export async function loadAllData(onStatus = () => {}) {
  onStatus("Loading inventory…");
  await Promise.all([loadBalances(), loadLibrary()]);
  onStatus("Loading transactions…");
  await loadTransactions();
}

/** Is this signed-in account an Inventory Administrator? Never throws (false when unsure). */
export async function lookupAdmin(email) {
  try {
    const e = String(email || "").trim().toLowerCase();
    if (!e) return false;
    const rows = await queryAll(CONFIG.USERS_LAYER_URL, { where: `LOWER(${CONFIG.USERS_EMAIL_FIELD}) = ${sqlStr(e)}`, pageSize: 5 });
    return rows.some((r) => String(r[CONFIG.USERS_PERMISSIONS_FIELD] || "") === CONFIG.ADMIN_PERMISSION_VALUE);
  } catch (err) {
    console.info("Admin lookup unavailable:", err.message);
    return false;
  }
}

// ---- balance queries used by the dialogs ------------------------------------------

/** In-stock balance rows for a SKU, optionally restricted to a location code and/or lot. */
export function balancesForSku(sku, { code = null, lot = undefined } = {}) {
  return S.balances.filter((r) =>
    String(r.item_sku || "").trim() === String(sku || "").trim() &&
    (Number(r.quantity_on_hand) || 0) > 0 &&
    (code === null || balanceCode(r) === code) &&
    (lot === undefined || String(r.lot_number || "").trim() === String(lot || "").trim()));
}

export function balancesAtCode(code) {
  return S.balances.filter((r) => balanceCode(r) === code && (Number(r.quantity_on_hand) || 0) > 0);
}

export const onHand = (r) => Number(r.quantity_on_hand) || 0;
