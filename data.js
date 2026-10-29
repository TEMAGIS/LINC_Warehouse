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

export async function resolveLayers() {
  const ids = CONFIG.ITEM_IDS;
  const [bal, txn, lib] = await Promise.all([
    serviceLayerUrl(ids.balance),
    serviceLayerUrl(ids.transactions),
    serviceLayerUrl(ids.library, { preferLayers: true }),
  ]);
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
