// ---------------------------------------------------------------------------
// Shipment plans: who a shipment is going to, where, and exactly which pick-line stock goes.
// Stored in a small hosted service this app can create (Settings → Create the shipments
// service), with two tables:
//   Shipments       one row per plan (recipient, ship-to location, reference, status)
//   Shipment_Lines  one row per item line (item, quantity, pick-line location, lot)
// Nothing here changes inventory. Inventory only changes when a plan is SHIPPED, which writes
// Ship transactions (see pickline.js → shipPlan).
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import * as auth from "./shared/arcgis-auth.js";
import { esriRequest, itemServiceUrl, findServicesByTitle, queryAll, applyServiceEdits, applyEdits } from "./shared/esri-client.js";
import { newTxnId } from "./shared/util.js";
import { S } from "./state.js";

const str = (name, length, alias) => ({ name, type: "esriFieldTypeString", alias: alias || name, length });
const int = (name, alias) => ({ name, type: "esriFieldTypeInteger", alias: alias || name });
const date = (name, alias) => ({ name, type: "esriFieldTypeDate", alias: alias || name });

export const PLAN_STATUS = { DRAFT: "Draft", READY: "Ready", SHIPPED: "Shipped", PARTLY: "Partly shipped", CANCELLED: "Cancelled" };
export const OPEN_STATUSES = [PLAN_STATUS.DRAFT, PLAN_STATUS.READY, PLAN_STATUS.PARTLY];

export const SHIPMENTS_TABLE = {
  name: "Shipments",
  displayField: "ship_to_name",
  fields: [
    str("shipment_id", 40, "Shipment ID"),
    str("status", 20, "Status"),
    str("recipient_name", 150, "Recipient"),
    str("recipient_org", 150, "Organization"),
    str("recipient_phone", 40, "Phone"),
    str("ship_to_name", 150, "Ship-to location"),
    str("ship_to_address", 255, "Address"),
    str("ship_to_city", 60, "City"),
    str("ship_to_state", 20, "State"),
    str("ship_to_zip", 15, "Zip"),
    str("ship_to_county", 60, "County"),
    str("order_ref", 80, "Order / reference"),
    date("requested_date", "Requested ship date"),
    str("notes", 500, "Notes"),
    int("line_count", "Lines"),
    int("total_qty", "Total quantity"),
    str("created_by", 150, "Created by"),
    date("created_date", "Created"),
    date("updated_date", "Updated"),
    str("shipped_by", 150, "Shipped by"),
    date("shipped_date", "Shipped"),
  ],
};

export const LINES_TABLE = {
  name: "Shipment_Lines",
  displayField: "item_desc",
  fields: [
    str("shipment_id", 40, "Shipment ID"),
    int("line_no", "Line"),
    str("item_sku", 60, "Item barcode / SKU"),
    str("item_desc", 255, "Item"),
    str("unit", 60, "Unit"),
    int("quantity", "Quantity"),
    str("lot", 60, "Lot"),
    str("from_location", 20, "Pick-line location code"),
    int("qty_shipped", "Quantity shipped"),
    str("status", 20, "Status"),
    str("note", 255, "Note"),
    str("transaction_gid", 50, "Ship transaction"),
  ],
};

function toTableDefinition(spec) {
  const base = (f) => ({ sqlType: "sqlTypeOther", nullable: true, editable: true, domain: null, defaultValue: null, ...f });
  return {
    name: spec.name, type: "Table", displayField: spec.displayField || "", description: "", copyrightText: "",
    defaultVisibility: true, relationships: [], isDataVersioned: false, supportsRollbackOnFailureParameter: true,
    supportsStatistics: true, supportsAdvancedQueries: true, geometryType: "", minScale: 0, maxScale: 0, extent: null,
    drawingInfo: null, hasM: false, hasZ: false, objectIdField: "OBJECTID", globalIdField: "", types: [], templates: [],
    hasAttachments: false, capabilities: "Query,Create,Update,Delete,Editing",
    editFieldsInfo: { creationDateField: "CreationDate", creatorField: "Creator", editDateField: "EditDate", editorField: "Editor" },
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", sqlType: "sqlTypeOther", nullable: false, editable: false, domain: null, defaultValue: null },
      ...spec.fields.map(base),
      base({ name: "CreationDate", type: "esriFieldTypeDate", alias: "CreationDate", length: 8, editable: false }),
      base({ name: "Creator", type: "esriFieldTypeString", alias: "Creator", length: 128, editable: false }),
      base({ name: "EditDate", type: "esriFieldTypeDate", alias: "EditDate", length: 8, editable: false }),
      base({ name: "Editor", type: "esriFieldTypeString", alias: "Editor", length: 128, editable: false }),
    ],
  };
}

const adminUrl = (u) => u.replace("/rest/services/", "/rest/admin/services/");

/** Creates the hosted service with both tables (publisher account needed). Returns {url, itemId}. */
export async function createShipmentsService() {
  const profile = await auth.fetchProfile();
  const username = (profile && profile.username) || auth.getUsername();
  const description = "LINC Warehouse: shipment plans and their lines";
  const created = await esriRequest(`${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/content/users/${encodeURIComponent(username)}/createService`, {
    createParameters: JSON.stringify({
      name: CONFIG.SHIPMENTS_SERVICE_TITLE, serviceDescription: description, hasStaticData: false, maxRecordCount: 2000,
      supportedQueryFormats: "JSON", capabilities: "Create,Delete,Query,Update,Editing", allowGeometryUpdates: true, units: "esriMeters",
      xssPreventionInfo: { xssPreventionEnabled: true, xssPreventionRule: "input", xssInputRule: "rejectInvalid" },
    }),
    outputType: "featureService", description, snippet: description, tags: "TEMA,LINC,warehouse",
  });
  const svc = String(created.serviceurl || created.encodedServiceURL || "").replace(/\/+$/, "");
  if (!svc) throw new Error("ArcGIS did not return a service URL.");
  await esriRequest(`${adminUrl(svc)}/addToDefinition`, { addToDefinition: JSON.stringify({ tables: [SHIPMENTS_TABLE, LINES_TABLE].map(toTableDefinition) }) });
  try {
    await esriRequest(`${adminUrl(svc)}/updateDefinition`, {
      updateDefinition: JSON.stringify({ editorTrackingInfo: { enableEditorTracking: true, enableOwnershipAccessControl: false, allowOthersToUpdate: true, allowOthersToDelete: true, allowOthersToQuery: true } }),
    });
  } catch (err) { console.warn("Editor tracking not enabled (optional):", err); }
  CONFIG.SHIPMENTS_SERVICE_URL = svc;
  return { url: svc, itemId: created.itemId || created.serviceItemId };
}

/** Finds the service (config URL / item ID, else by title) and its two table ids. Never throws. */
export async function discoverShipments() {
  const H = S.shipments;
  H.ready = false;
  try {
    let url = CONFIG.SHIPMENTS_SERVICE_URL;
    if (!url && CONFIG.SHIPMENTS_ITEM_ID) url = await itemServiceUrl(CONFIG.SHIPMENTS_ITEM_ID);
    if (!url) {
      const found = await findServicesByTitle(CONFIG.SHIPMENTS_SERVICE_TITLE);
      if (found.length) url = String(found[0].url || "").replace(/\/+$/, "") || (await itemServiceUrl(found[0].id));
    }
    if (!url) return false;
    const meta = await esriRequest(url, {}, { method: "GET" });
    const t = meta.tables || [];
    const head = t.find((x) => x.name === SHIPMENTS_TABLE.name);
    const lines = t.find((x) => x.name === LINES_TABLE.name);
    if (!head || !lines) return false;
    H.url = url; H.headerId = head.id; H.linesId = lines.id; H.ready = true;
    return true;
  } catch (err) {
    console.info("Shipments service not available:", err.message);
    return false;
  }
}

export async function loadShipments() {
  const H = S.shipments;
  if (!H.ready) { H.headers = []; H.lines = []; return; }
  [H.headers, H.lines] = await Promise.all([
    queryAll(`${H.url}/${H.headerId}`, { orderByFields: "created_date DESC", pageSize: 1000 }),
    queryAll(`${H.url}/${H.linesId}`, { orderByFields: "shipment_id ASC, line_no ASC", pageSize: 2000 }),
  ]);
}

export function newShipmentId(now = new Date()) {
  return newTxnId(now).replace(/^TXN-/, "SHP-").replace(/-[A-Z0-9]{6}$/, (m) => m.slice(0, 5));
}

export const linesOf = (shipmentId) => S.shipments.lines.filter((l) => l.shipment_id === shipmentId).sort((a, b) => (a.line_no || 0) - (b.line_no || 0));

const nowMs = () => Date.now();

/** Quantity already promised to OPEN plans for one pick-line row (sku + location code + lot). */
export function plannedQty(sku, code, lot, { exceptShipmentId = "" } = {}) {
  const open = new Set(S.shipments.headers.filter((h) => OPEN_STATUSES.includes(h.status) && h.shipment_id !== exceptShipmentId).map((h) => h.shipment_id));
  let n = 0;
  for (const l of S.shipments.lines) {
    if (!open.has(l.shipment_id)) continue;
    if (String(l.status || "") === "Shipped") continue;
    if (String(l.item_sku || "").trim() !== String(sku || "").trim()) continue;
    if (String(l.from_location || "") !== String(code || "")) continue;
    if (String(l.lot || "").trim() !== String(lot || "").trim()) continue;
    n += Number(l.quantity) - (Number(l.qty_shipped) || 0);
  }
  return n;
}

function totals(lines) {
  return { line_count: lines.length, total_qty: lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0) };
}

/** Creates or replaces a plan: header + all lines in ONE transaction. Returns the saved header attrs. */
export async function savePlan(header, lines, { existing = null } = {}) {
  const H = S.shipments;
  if (!H.ready) throw new Error("The shipments service isn't set up yet (Settings → Create the shipments service).");
  const t = totals(lines);
  const attrs = { ...header, ...t, updated_date: nowMs() };
  const lineFields = LINES_TABLE.fields.map((f) => f.name);
  const lineAttrs = lines.map((l, i) => {
    const clean = {};
    for (const k of lineFields) if (l[k] !== undefined && l[k] !== null) clean[k] = l[k]; // drops OBJECTID, CreationDate, _oid ...
    return { ...clean, shipment_id: attrs.shipment_id, line_no: i + 1, status: l.status || "Planned", qty_shipped: l.qty_shipped || 0 };
  });
  const edits = [];
  if (existing) {
    const oldLines = linesOf(existing.shipment_id);
    edits.push({ id: H.headerId, updates: [{ attributes: { ...attrs, OBJECTID: existing.OBJECTID ?? existing._oid } }] });
    edits.push({ id: H.linesId, deletes: oldLines.map((l) => l.OBJECTID ?? l._oid), adds: lineAttrs.map((a) => ({ attributes: a })) });
  } else {
    attrs.created_by = S.me.name;
    attrs.created_date = nowMs();
    edits.push({ id: H.headerId, adds: [{ attributes: attrs }] });
    edits.push({ id: H.linesId, adds: lineAttrs.map((a) => ({ attributes: a })) });
  }
  await applyServiceEdits(H.url, edits);
  await loadShipments();
  return attrs;
}

/** Status / small patches on the header only. */
export async function patchHeader(header, patch) {
  const H = S.shipments;
  await applyEdits(`${H.url}/${H.headerId}`, { updates: [{ attributes: { OBJECTID: header.OBJECTID ?? header._oid, ...patch, updated_date: nowMs() } }] });
  await loadShipments();
}

/** Line patches after shipping: [{line, patch}] */
export async function patchLines(items) {
  const H = S.shipments;
  if (!items.length) return;
  await applyEdits(`${H.url}/${H.linesId}`, { updates: items.map(({ line, patch }) => ({ attributes: { OBJECTID: line.OBJECTID ?? line._oid, ...patch } })) });
}
