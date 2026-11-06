// ---------------------------------------------------------------------------
// Adds the fields this app uses to the existing hosted layers (Transactions, Inventory
// Balance, Barcode Library) when they're missing. Uses the layer's admin addToDefinition,
// so it needs the account that owns the layers (or an org administrator). Those three are
// hosted VIEWS, which can't take new columns: the fields go on the view's source layer and are
// then switched on in the view.
// Only ADDS fields. Never edits or deletes existing ones.
// Note: if a layer is published from a Survey123 form, republishing that form from
// Survey123 can remove fields added here. Add them to the survey too (or stop republishing).
// ---------------------------------------------------------------------------
import { esriRequest } from "./shared/esri-client.js";
import { S } from "./state.js";
import { resolveLayers } from "./data.js";
import { discoverShipments } from "./shipments.js";

const str = (name, length, alias = name) => ({ name, alias, type: "esriFieldTypeString", length });
const dbl = (name, alias = name) => ({ name, alias, type: "esriFieldTypeDouble" });
const dat = (name, alias = name) => ({ name, alias, type: "esriFieldTypeDate", length: 8 });

/** Fields the app writes or reads that survey forms may not have created. */
export const WANTED = {
  txn: [
    str("shipment_id", 50, "Shipment ID"),
    str("ship_to", 255, "Ship to"),
    str("property_owner", 50, "Property owner"),
    str("unit_of_measure", 50, "Unit of measure"),
    str("processing_status", 20, "Processing status"),
    str("processing_error", 255, "Processing error"),
    dat("processed_at", "Processed at"),
    str("inventory_balance_gids", 500, "Inventory balance GlobalIDs"),
    str("adjust_reason", 255, "Adjust reason"),
  ],
  bal: [
    str("last_transaction_id", 50, "Last transaction ID"),
    str("property_owner", 50, "Property owner"),
    dbl("quantity_available", "Quantity available"),
    str("unit_of_measure", 50, "Unit of measure"),
    str("item", 255, "Item"),
  ],
  lib: [
    str("count_unit", 30, "Count unit"),
    { name: "units_per_pack", alias: "Units per pack", type: "esriFieldTypeInteger" },
    dbl("unit_volume", "Unit volume"),
    str("unit_volume_uom", 20, "Unit volume UOM"),
    dbl("gallons_per_count_unit", "Gallons per count unit"),
    str("delete_flag", 5, "Flagged for delete"),
    str("delete_reason", 255, "Delete reason"),
    str("flagged_by", 150, "Flagged by"),
    dat("flagged_date", "Flagged date"),
  ],
  // Tables of the shipments service (their URLs are set when the service is found)
  lines: [str("property_owner", 50, "Property owner")],
  usr: [str("property_owner_of", 255, "Property owner of")],
};

export const LABELS = { txn: "Transactions", bal: "Inventory Balance", lib: "Barcode Library", lines: "Shipment lines", usr: "Warehouse users" };

/** {key: [field specs not on the live layer]} (only layers whose fields could be read). */
export function missingFields() {
  const out = {};
  for (const key of Object.keys(WANTED)) {
    const info = S.info[key];
    const live = new Set(((info && info.fields) || []).map((f) => f.name.toLowerCase()));
    if (!live.size) continue;
    const miss = WANTED[key].filter((f) => !live.has(f.name.toLowerCase()));
    if (miss.length) out[key] = miss;
  }
  return out;
}

const adminUrl = (u) => u.replace("/rest/services/", "/rest/admin/services/");

const toDef = (f) => ({ sqlType: "sqlTypeOther", nullable: true, editable: true, domain: null, defaultValue: null, ...f });

const addFields = (layerUrl, fields) =>
  esriRequest(`${adminUrl(layerUrl)}/addToDefinition`, { addToDefinition: JSON.stringify({ fields: fields.map(toDef) }) });

const fieldNames = (info) => new Set(((info && info.fields) || []).map((f) => f.name.toLowerCase()));

/**
 * The source layer behind a hosted feature layer VIEW. ArcGIS won't add columns to a view, so the
 * fields go on the source layer, then are switched on in the view. Returns null when it isn't a view.
 */
async function viewSource(viewUrl, info) {
  const m = String(viewUrl).replace(/\/+$/, "").match(/^(.*\/FeatureServer)\/(\d+)$/i);
  if (!m) return null;
  const isView = !!(info && info.raw && info.raw.isView);
  let src;
  try {
    const data = await esriRequest(`${m[1]}/sources`, {}, { method: "GET" });
    src = (data.services || [])[0];
  } catch (err) {
    if (isView) throw new Error(`This layer is a view and its source service couldn't be found (${err.message}).`);
    return null;
  }
  if (!src || !src.url) return null;
  // Which source layer: the view's admin definition says; usually it's the same id.
  let srcId = m[2];
  try {
    const adm = await esriRequest(adminUrl(`${m[1]}/${m[2]}`), {}, { method: "GET" });
    const t = adm.adminLayerInfo && adm.adminLayerInfo.viewLayerDefinition && adm.adminLayerInfo.viewLayerDefinition.table;
    if (t && t.sourceLayerId !== undefined && t.sourceLayerId !== null) srcId = String(t.sourceLayerId);
  } catch { /* keep the same id */ }
  return { url: `${src.url.replace(/\/+$/, "")}/${srcId}`, view: `${m[1]}/${m[2]}` };
}

/**
 * Adds the missing fields to one layer, then re-reads the layers. Returns the names added.
 * Inventory Balance, Transactions and the Barcode Library are hosted VIEWS: ArcGIS refuses to add
 * columns to a view ("Columns cannot be added to view services"), so for those the fields are added
 * to the view's source layer and then made visible in the view.
 */
export async function addMissingFields(key) {
  const miss = (missingFields()[key]) || [];
  if (!miss.length) return [];
  const url = S.urls[key];
  if (!url) throw new Error("That layer's URL isn't known.");
  const info = S.info[key];
  const src = info && info.raw && info.raw.isView ? await viewSource(url, info) : null;
  if (!src) {
    try {
      await addFields(url, miss);
    } catch (err) {
      if (!/view/i.test(err.message)) throw err;
      const s2 = await viewSource(url, info);
      if (!s2) throw err;
      await addToViewSource(s2, miss);
    }
  } else {
    await addToViewSource(src, miss);
  }
  if (key === "lines" || key === "usr") await discoverShipments();
  else await resolveLayers();
  const still = new Set(((missingFields()[key]) || []).map((f) => f.name));
  const added = miss.map((f) => f.name).filter((n) => !still.has(n));
  if (still.size) {
    throw new Error(`Added to the source layer, but ${[...still].join(", ")} still ${still.size === 1 ? "isn't" : "aren't"} visible in the view. In ArcGIS Online open the view item → Visualization (or Data → Fields) → Define view → Fields, tick ${still.size === 1 ? "it" : "them"} and save.`);
  }
  return added;
}

/** Source first (only what it lacks), then switch the fields on in the view. */
async function addToViewSource(src, miss) {
  let srcInfo = null;
  try { srcInfo = await esriRequest(src.url, {}, { method: "GET" }); } catch (err) {
    throw new Error(`Couldn't open the view's source layer (${src.url}): ${err.message}. Sign in as the account that owns the source service.`);
  }
  const have = fieldNames(srcInfo);
  const toSource = miss.filter((f) => !have.has(f.name.toLowerCase()));
  if (toSource.length) await addFields(src.url, toSource);
  try {
    await esriRequest(`${adminUrl(src.view)}/updateDefinition`, {
      updateDefinition: JSON.stringify({ fields: miss.map((f) => ({ name: f.name, visible: true })) }),
    });
  } catch (err) {
    console.info("Couldn't switch the new fields on in the view (they may already show):", err.message);
  }
}
