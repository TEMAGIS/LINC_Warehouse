// ---------------------------------------------------------------------------
// Applying a transaction to Inventory Balance, in the browser. A port of the webhook Lambda's
// apply_transaction(), with the same rules:
//   * Receive adds to the "to" location; Ship takes from the "from" location; Move does both.
//   * All-or-nothing: every leg is validated before anything is written. A leg that would go
//     negative, or has no stock to take from, rejects the whole transaction.
//   * A Move's two balance rows are written in ONE applyEdits call (ArcGIS rolls both back on failure).
//   * Ship is only allowed from the pick line.
// Rows are matched on site + item + location segments + lot with NULL-safe clauses (hosted layers
// store empty strings as NULL), so a blank zone / lot never creates a duplicate balance row.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { esriRequest, applyEdits } from "./shared/esri-client.js";
import { S } from "./state.js";
import { isPicklineZone } from "./loc.js";

export class TransactionApplyError extends Error {}

// Transactions segment name -> Inventory Balance field name (the two forms were built separately)
export const SEGMENT_FIELD_MAP = { zone: "zone", row: "aisle", bay: "bay", level: "level", position: "position" };

const q = (v) => String(v ?? "").replace(/'/g, "''");

/** NULL-safe equality for an optional text field. */
export function eqClause(field, val) {
  const v = val || "";
  return v === "" ? `(${field} IS NULL OR ${field} = '')` : `${field} = '${q(v)}'`;
}

export function buildSegmentWhere(site, sku, lot, attrs, prefix) {
  const clauses = [eqClause("site", site), eqClause("item_sku", sku)];
  for (const [t, b] of Object.entries(SEGMENT_FIELD_MAP)) clauses.push(eqClause(b, attrs[`${prefix}${t}`]));
  clauses.push(eqClause("lot_number", lot));
  return clauses.join(" AND ");
}

export const segmentLabel = (attrs, prefix) => ["zone", "row", "bay", "level", "position"].map((f) => attrs[`${prefix}${f}`] || "").join("-");

/** [[prefix, delta], ...] for a transaction; throws TransactionApplyError when it can't be valid. */
export function planMoves(attrs) {
  const type = String(attrs.transaction_type || "").trim();
  const qty = Number(attrs.quantity);
  if (!Number.isInteger(qty)) throw new TransactionApplyError(`quantity is not a number: ${attrs.quantity}`);
  if (qty <= 0) throw new TransactionApplyError(`quantity must be > 0, got ${qty}`);
  if (type === "Receive") return [["to_", qty]];
  if (type === "Ship") {
    if (!isPicklineZone(attrs.from_zone)) {
      throw new TransactionApplyError(`Ship must come from the pick line (zone ${CONFIG.PICKLINE.ZONE}); ${segmentLabel(attrs, "from_") || "that location"} is not on it. Stage it to the pick line first.`);
    }
    return [["from_", -qty]];
  }
  if (type === "Move") return [["from_", -qty], ["to_", qty]];
  throw new TransactionApplyError(`unrecognized transaction_type: ${type}`);
}

const oidKey = (row) => Object.keys(row).find((k) => k.toLowerCase() === "objectid") || (S.info.bal && S.info.bal.objectIdField) || "OBJECTID";

async function queryBalance(where) {
  const data = await esriRequest(`${S.urls.bal}/query`, { where, outFields: "*", returnGeometry: "false" });
  return (data.features || []).map((f) => f.attributes);
}

function fitBalance(attrs) {
  const info = S.info.bal;
  if (!info || !info.fields || !info.fields.length) return attrs;
  const names = new Map(info.fields.map((f) => [f.name.toLowerCase(), f.name]));
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    const real = names.get(k.toLowerCase());
    if (real && v !== undefined) out[real] = v;
  }
  return out;
}

/**
 * Applies one transaction (the attributes of a Transactions row, including its `globalid`) to the
 * balance layer. Returns {ok, message, gids, already?}. Never throws for business-rule problems.
 */
export async function applyToBalance(attrs, { now = Date.now() } = {}) {
  let moves;
  try {
    moves = planMoves(attrs);
  } catch (err) {
    return { ok: false, message: err.message, gids: [] };
  }
  const site = attrs.site || CONFIG.SITE;
  const sku = attrs.item_sku;
  const lot = attrs.lot;
  const gid = String(attrs.globalid || "").replace(/[{}]/g, "").toLowerCase();

  // Idempotency: if a balance row already carries this transaction's id, it was applied (e.g. the
  // status stamp failed last time). Don't apply twice.
  if (gid) {
    const done = await queryBalance(`last_transaction_id = '${q(attrs.globalid)}' OR last_transaction_id = '${q(gid)}'`).catch(() => []);
    if (done.length) return { ok: true, already: true, message: "already applied", gids: done.map((r) => r.globalid || r.GlobalID).filter(Boolean) };
  }

  const planned = [];
  for (const [prefix, delta] of moves) {
    const rows = await queryBalance(buildSegmentWhere(site, sku, lot, attrs, prefix));
    const existing = rows[0] || null;
    const label = segmentLabel(attrs, prefix);
    let next;
    if (!existing) {
      if (delta < 0) return { ok: false, message: `No existing balance found for ${label} / ${sku} / lot=${lot || "(none)"} — cannot subtract from a location with no recorded stock.`, gids: [] };
      next = delta;
    } else {
      const cur = Number(existing.quantity_on_hand) || 0;
      next = cur + delta;
      if (next < 0) return { ok: false, message: `Applying ${delta} to ${label} / ${sku} would drive quantity_on_hand negative (${cur} -> ${next}).`, gids: [] };
    }
    planned.push({ existing, next, prefix });
  }

  const adds = [];
  const updates = [];
  for (const p of planned) {
    const allocated = (p.existing && Number(p.existing.quantity_allocated)) || 0;
    const label = segmentLabel(attrs, p.prefix);
    const common = fitBalance({
      site,
      location_scan: attrs[`${p.prefix}location_scan`],
      zone: attrs[`${p.prefix}zone`],
      aisle: attrs[`${p.prefix}row`],
      bay: attrs[`${p.prefix}bay`],
      level: attrs[`${p.prefix}level`],
      position: attrs[`${p.prefix}position`],
      segment: label,
      location_label: label,
      item_sku: sku,
      lot_number: lot || "",
      category: attrs.category,
      item: attrs.item,
      make: attrs.make,
      model: attrs.model,
      description: attrs.description,
      weight: attrs.weight,
      dimensions: attrs.dimensions,
      unit_of_measure: attrs.unit_of_measure,
      quantity_on_hand: p.next,
      quantity_allocated: allocated,
      quantity_available: p.next - allocated,
      last_transaction_id: attrs.globalid,
      last_update: now,
    });
    if (p.existing) {
      const k = oidKey(p.existing);
      updates.push({ attributes: { ...common, [k]: p.existing[k] } });
    } else adds.push({ attributes: common });
  }
  try {
    const res = await applyEdits(S.urls.bal, { adds, updates }); // one call: both legs or neither
    const gids = [...(res.addResults || []), ...(res.updateResults || [])].map((r) => r.globalId).filter(Boolean);
    return { ok: true, message: "ok", gids };
  } catch (err) {
    return { ok: false, message: `Could not update Inventory Balance: ${err.message}`, gids: [] };
  }
}
