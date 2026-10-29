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
import { esriRequest, itemServiceUrl, findServicesByTitle, queryAll, applyServiceEdits, applyEdits, getLayerInfo } from "./shared/esri-client.js";
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
    str("property_owner", 50, "Property owner"),
  ],
};

// Who may use the app and in what role (see users.js). Lives in the same hosted service.
export const USERS_TABLE = {
  name: "Users",
  displayField: "full_name",
  fields: [
    str("email", 150, "Email"),
    str("username", 100, "ArcGIS username"),
    str("full_name", 150, "Name"),
    str("role", 20, "Role"),
    str("active", 5, "Active"),
    str("phone", 40, "Phone"),
    str("notes", 255, "Notes"),
    str("property_owner_of", 255, "Property owner of"),
    str("added_by", 150, "Added by"),
    date("added_date", "Added"),
  ],
};

// Property owners (groups that receive and manage their own consumables). Edited in Settings (owners.js).
export const OWNERS_TABLE = {
  name: "Owners",
  displayField: "name",
  fields: [
    str("code", 30, "Code"),
    str("name", 120, "Name"),
    str("active", 5, "Active"),
    str("notes", 255, "Notes"),
    str("added_by", 150, "Added by"),
    date("added_date", "Added"),
  ],
};

// Warehouse locations placed on the map: one POINT per bay (zone + row + bay). Edited on the Map tab (map.js).
export const LOCATIONS_LAYER = {
  name: "Locations",
  displayField: "bay_code",
  fields: [
    str("bay_code", 12, "Bay code"),
    str("label", 120, "Label"),
    str("location_type", 30, "Type"),
    int("capacity", "Capacity (units)"),
    str("active", 5, "Active"),
    str("notes", 255, "Notes"),
    str("added_by", 150, "Added by"),
    date("added_date", "Added"),
  ],
};

function toLayerDefinition(spec) {
  const t = toTableDefinition(spec);
  return {
    ...t, type: "Feature Layer", geometryType: "esriGeometryPoint",
    extent: { xmin: -20037508.34, ymin: -20037508.34, xmax: 20037508.34, ymax: 20037508.34, spatialReference: { wkid: 102100, latestWkid: 3857 } },
    drawingInfo: { renderer: { type: "simple", symbol: { type: "esriSMS", style: "esriSMSCircle", color: [0, 40, 104, 255], size: 8, outline: { color: [255, 255, 255, 255], width: 1 } } } },
    allowGeometryUpdates: true,
  };
}

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
  const description = "LINC Warehouse: shipment plans, their lines, the warehouse user list and property owners";
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
  await esriRequest(`${adminUrl(svc)}/addToDefinition`, { addToDefinition: JSON.stringify({ tables: [SHIPMENTS_TABLE, LINES_TABLE, USERS_TABLE, OWNERS_TABLE].map(toTableDefinition) }) });
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
  H.usersId = null;
  H.ownersId = null;
  H.locationsId = null;
  S.usersReady = false;
  try {
    let url = CONFIG.SHIPMENTS_SERVICE_URL;
    let itemId = CONFIG.SHIPMENTS_ITEM_ID || "";
    if (!url && CONFIG.SHIPMENTS_ITEM_ID) url = await itemServiceUrl(CONFIG.SHIPMENTS_ITEM_ID);
    if (!url) {
      const found = await findServicesByTitle(CONFIG.SHIPMENTS_SERVICE_TITLE);
      if (found.length) { itemId = found[0].id; url = String(found[0].url || "").replace(/\/+$/, "") || (await itemServiceUrl(found[0].id)); }
    }
    if (!url) return false;
    const meta = await esriRequest(url, {}, { method: "GET" });
    const t = meta.tables || [];
    const head = t.find((x) => x.name === SHIPMENTS_TABLE.name);
    const lines = t.find((x) => x.name === LINES_TABLE.name);
    if (!head || !lines) return false;
    const users = t.find((x) => x.name === USERS_TABLE.name);
    H.url = url; H.headerId = head.id; H.linesId = lines.id; H.ready = true;
    H.usersId = users ? users.id : null;
    const owners = t.find((x) => x.name === OWNERS_TABLE.name);
    H.ownersId = owners ? owners.id : null;
    const locs = (meta.layers || []).find((x) => x.name === LOCATIONS_LAYER.name);
    H.locationsId = locs ? locs.id : null;
    H.itemId = itemId;
    H.caps = String(meta.capabilities || "");
    S.usersReady = !!users;
    // Field lists of the Shipment_Lines and Users tables (for the property-owner field checks)
    S.urls = { ...S.urls, lines: `${url}/${lines.id}`, usr: users ? `${url}/${users.id}` : "" };
    try {
      const [li, ui] = await Promise.all([getLayerInfo(S.urls.lines), users ? getLayerInfo(S.urls.usr) : null]);
      S.info = { ...S.info, lines: li, usr: ui };
    } catch (err) { console.info("Couldn't read the shipments tables' fields:", err.message); }
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
export function plannedQty(sku, code, lot, { exceptShipmentId = "", owner = undefined } = {}) {
  const open = new Set(S.shipments.headers.filter((h) => OPEN_STATUSES.includes(h.status) && h.shipment_id !== exceptShipmentId).map((h) => h.shipment_id));
  let n = 0;
  for (const l of S.shipments.lines) {
    if (!open.has(l.shipment_id)) continue;
    if (String(l.status || "") === "Shipped") continue;
    if (String(l.item_sku || "").trim() !== String(sku || "").trim()) continue;
    if (String(l.from_location || "") !== String(code || "")) continue;
    if (String(l.lot || "").trim() !== String(lot || "").trim()) continue;
    if (owner !== undefined && String(l.property_owner || "").trim().toLowerCase() !== String(owner || "").trim().toLowerCase()) continue;
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
  const liveLine = new Set(((S.info.lines && S.info.lines.fields) || []).map((f) => f.name.toLowerCase()));
  const lineFields = LINES_TABLE.fields.map((f) => f.name).filter((n) => n !== "property_owner" || liveLine.has("property_owner"));
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

/** Adds the Users table to a service created before the user list existed (service owner / admin account). */
export async function addUsersTable() {
  const H = S.shipments;
  if (!H.url) throw new Error("The shipments service wasn't found.");
  await esriRequest(`${adminUrl(H.url)}/addToDefinition`, { addToDefinition: JSON.stringify({ tables: [toTableDefinition(USERS_TABLE)] }) });
  await discoverShipments();
  if (!S.usersReady) throw new Error("The table was added but couldn't be found afterwards. Reload the page.");
}

/** Adds the Owners table to a service created before property owners existed (service owner / admin account). */
export async function addOwnersTable() {
  const H = S.shipments;
  if (!H.url) throw new Error("The shipments service wasn't found.");
  await esriRequest(`${adminUrl(H.url)}/addToDefinition`, { addToDefinition: JSON.stringify({ tables: [toTableDefinition(OWNERS_TABLE)] }) });
  await discoverShipments();
  if (H.ownersId === null || H.ownersId === undefined) throw new Error("The table was added but couldn't be found afterwards. Reload the page.");
}

/** Adds the Locations point layer to the shipments service (publisher account needed). */
export async function addLocationsLayer() {
  const H = S.shipments;
  if (!H.url) throw new Error("The shipments service wasn't found.");
  await esriRequest(`${adminUrl(H.url)}/addToDefinition`, { addToDefinition: JSON.stringify({ layers: [toLayerDefinition(LOCATIONS_LAYER)] }) });
  await discoverShipments();
  if (H.locationsId === null || H.locationsId === undefined) throw new Error("The layer was added but couldn't be found afterwards. Reload the page.");
}
