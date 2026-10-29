// ---------------------------------------------------------------------------
// Warehouse locations on the map. One POINT per bay (zone + row + bay), stored in the
// "Locations" layer of the shipments service. Stock is matched to a bay by the first part of
// its location code (everything except the level and position), so a bay's pin shows the stock on
// all of its levels and positions.
// ---------------------------------------------------------------------------
import { S } from "./state.js";
import { queryAll, applyEdits, getLayerInfo } from "./shared/esri-client.js";
import { parseCode, codeLabel, balanceCode } from "./loc.js";
import { onHand } from "./data.js";

export const LOCATION_TYPES = ["Reserve", "Pick face", "Staging", "Dock", "Other"];

/** Bay code for any location code: zone + row + bay ("Z1-AA-01-01-P1" -> "Z1AA01"; no zone: "AA01"). null when it isn't a code. */
export function bayKey(raw) {
  const p = parseCode(raw);
  return p ? `${p.zone}${p.row}${p.bay}` : null;
}

/** "Z1AA01" or "AA01" -> "Z1-AA-01" (display). */
export const bayLabel = (key) => {
  const c = String(key || "");
  return c.length === 6 ? `${c.slice(0, 2)}-${c.slice(2, 4)}-${c.slice(4, 6)}` : c.length === 4 ? `${c.slice(0, 2)}-${c.slice(2, 4)}` : c;
};

/** What the user typed -> a bay code, or null. Accepts "Z1-AA-01", "z1aa01", "AA01". */
export function parseBayInput(raw) {
  const c = String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return c.length === 6 || c.length === 4 ? c : null;
}

// ---- Web Mercator <-> longitude / latitude (the layer is stored in Web Mercator) -----------------
const R = 6378137;
export const toMercator = (lng, lat) => ({ x: (lng * Math.PI * R) / 180, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) });
export const fromMercator = (x, y) => ({ lng: (x / R) * (180 / Math.PI), lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI) });

const H = () => S.shipments;
export const locationsReady = () => !!(H().ready && H().locationsId !== null && H().locationsId !== undefined);
export const locationsUrl = () => `${H().url}/${H().locationsId}`;
const caps = () => String((S.info.locs && S.info.locs.raw && S.info.locs.raw.capabilities) || "").toLowerCase();
export const canEditLocations = () => S.canEdit && S.isAdmin && locationsReady() && (caps().includes("editing") || caps().includes("update"));

S.locations = S.locations || [];

export async function loadLocations() {
  if (!locationsReady()) { S.locations = []; return S.locations; }
  const url = locationsUrl();
  if (!S.info.locs) { try { S.info = { ...S.info, locs: await getLayerInfo(url) }; } catch (err) { console.info("Couldn't read the Locations layer info:", err.message); } }
  const rows = await queryAll(url, { pageSize: 2000, returnGeometry: true, oidField: (S.info.locs && S.info.locs.objectIdField) || "OBJECTID" });
  S.locations = rows.map((r) => {
    const g = r._geom;
    const ll = g && Number.isFinite(g.x) ? fromMercator(g.x, g.y) : null;
    return { oid: r._oid, bay: String(r.bay_code || "").toUpperCase(), label: r.label || "", type: r.location_type || "", capacity: r.capacity ?? null, active: String(r.active || "yes").toLowerCase() !== "no", notes: r.notes || "", lat: ll ? ll.lat : null, lng: ll ? ll.lng : null };
  });
  return S.locations;
}

/** Stock per bay: { qty, lines: [{sku, name, qty, code}], pick }. Keyed by bay code. */
export function stockByBay() {
  const out = new Map();
  for (const r of S.balances) {
    const q = onHand(r);
    if (q <= 0) continue;
    const key = bayKey(balanceCode(r));
    if (!key) continue;
    const e = out.get(key) || { qty: 0, lines: [] };
    e.qty += q;
    e.lines.push({ r, qty: q, code: balanceCode(r) });
    out.set(key, e);
  }
  return out;
}

/** Bays that hold stock but have no pin on the map yet. */
export function unplacedBays() {
  const placed = new Set(S.locations.filter((l) => l.lat !== null).map((l) => l.bay));
  return [...stockByBay().entries()].filter(([k]) => !placed.has(k)).map(([bay, e]) => ({ bay, qty: e.qty })).sort((a, b) => a.bay.localeCompare(b.bay));
}

// ---- saving --------------------------------------------------------------------------------------
const geom = (lng, lat) => ({ ...toMercator(lng, lat), spatialReference: { wkid: 102100, latestWkid: 3857 } });
const oidKey = () => (S.info.locs && S.info.locs.objectIdField) || "OBJECTID";
const cleanType = (t) => (LOCATION_TYPES.includes(t) ? t : "Reserve");

export async function addLocation({ bay, label = "", type = "Reserve", capacity = null, notes = "", lng, lat }) {
  if (!canEditLocations()) throw new Error("Your account can't edit the Locations layer.");
  const key = parseBayInput(bay);
  if (!key) throw new Error("Enter the bay as zone + row + bay, like Z1-AA-01 (or AA-01 when there is no zone).");
  if (S.locations.some((l) => l.bay === key)) throw new Error(`${bayLabel(key)} is already on the map. Move or edit it instead.`);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("Click a spot on the map.");
  const cap = capacity === "" || capacity === null || capacity === undefined ? null : Math.round(Number(capacity));
  if (cap !== null && !(cap >= 0)) throw new Error("Capacity must be a whole number.");
  await applyEdits(locationsUrl(), { adds: [{ attributes: { bay_code: key, label: String(label || "").trim() || bayLabel(key), location_type: cleanType(type), capacity: cap, active: "yes", notes: String(notes || "").slice(0, 255), added_by: S.me.name, added_date: Date.now() }, geometry: geom(lng, lat) }] });
  await loadLocations();
}

export async function moveLocation(oid, lng, lat) {
  if (!canEditLocations()) throw new Error("Your account can't edit the Locations layer.");
  await applyEdits(locationsUrl(), { updates: [{ attributes: { [oidKey()]: oid }, geometry: geom(lng, lat) }] });
  await loadLocations();
}

export async function updateLocation(oid, { label, type, capacity, active, notes }) {
  if (!canEditLocations()) throw new Error("Your account can't edit the Locations layer.");
  const cap = capacity === "" || capacity === null || capacity === undefined ? null : Math.round(Number(capacity));
  if (cap !== null && !(cap >= 0)) throw new Error("Capacity must be a whole number.");
  await applyEdits(locationsUrl(), { updates: [{ attributes: { [oidKey()]: oid, label: String(label || "").trim(), location_type: cleanType(type), capacity: cap, active: active === false ? "no" : "yes", notes: String(notes || "").slice(0, 255) } }] });
  await loadLocations();
}

export async function deleteLocation(oid) {
  if (!canEditLocations()) throw new Error("Your account can't edit the Locations layer.");
  await applyEdits(locationsUrl(), { deletes: [oid] });
  await loadLocations();
}

export { codeLabel };
