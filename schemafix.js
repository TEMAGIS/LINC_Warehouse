// ---------------------------------------------------------------------------
// Adds the fields this app uses to the existing hosted layers (Transactions, Inventory
// Balance, Barcode Library) when they're missing. Uses the layer's admin addToDefinition,
// so it needs the account that owns the layers (or an org administrator).
// Only ADDS fields. Never edits or deletes existing ones.
// Note: if a layer is published from a Survey123 form, republishing that form from
// Survey123 can remove fields added here. Add them to the survey too (or stop republishing).
// ---------------------------------------------------------------------------
import { esriRequest } from "./shared/esri-client.js";
import { S } from "./state.js";
import { resolveLayers } from "./data.js";

const str = (name, length, alias = name) => ({ name, alias, type: "esriFieldTypeString", length });
const dbl = (name, alias = name) => ({ name, alias, type: "esriFieldTypeDouble" });
const dat = (name, alias = name) => ({ name, alias, type: "esriFieldTypeDate", length: 8 });

/** Fields the app writes or reads that survey forms may not have created. */
export const WANTED = {
  txn: [
    str("shipment_id", 50, "Shipment ID"),
    str("ship_to", 255, "Ship to"),
    str("unit_of_measure", 50, "Unit of measure"),
    str("processing_status", 20, "Processing status"),
    str("processing_error", 255, "Processing error"),
    dat("processed_at", "Processed at"),
    str("inventory_balance_gids", 500, "Inventory balance GlobalIDs"),
  ],
  bal: [
    str("last_transaction_id", 50, "Last transaction ID"),
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
};

export const LABELS = { txn: "Transactions", bal: "Inventory Balance", lib: "Barcode Library" };

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

/** Adds the missing fields to one layer, then re-reads the layers. Returns the names added. */
export async function addMissingFields(key) {
  const miss = (missingFields()[key]) || [];
  if (!miss.length) return [];
  const url = S.urls[key];
  if (!url) throw new Error("That layer's URL isn't known.");
  await esriRequest(`${adminUrl(url)}/addToDefinition`, { addToDefinition: JSON.stringify({ fields: miss.map(toDef) }) });
  await resolveLayers();
  return miss.map((f) => f.name);
}
