// ---------------------------------------------------------------------------
// Property owners: the group responsible for a batch of consumables.
//   * The list lives in the `Owners` table of the shipments service (Settings edits it).
//   * Each Inventory Balance row and Transaction carries `property_owner` (the owner's code).
//     The same item at the same shelf and lot held by two groups is TWO balance rows.
//   * A Users row can list `property_owner_of` codes. Such "group staff" can receive, move,
//     stage and ship ONLY stock owned by those groups. Administrators, and staff with no group,
//     can handle everything. Everyone can still view all stock.
//   * Everything is dormant until the table, the fields and at least one owner exist
//     (ownersActive()), so the app behaves exactly as before until Settings is set up.
// The app only decides what to offer; ArcGIS sharing still decides what an account can write.
// ---------------------------------------------------------------------------
import { S } from "./state.js";
import { applyEdits, queryAll } from "./shared/esri-client.js";
import { balanceCode } from "./loc.js";

export const OWNER_FIELD = "property_owner";
export const OWNER_OF_FIELD = "property_owner_of";
const lc = (v) => String(v ?? "").trim().toLowerCase();
export const norm = (v) => String(v ?? "").trim();
export const sameOwner = (a, b) => lc(a) === lc(b);
const qty = (r) => Number(r.quantity_on_hand) || 0;

export const ownedList = (u) => (!u ? [] : String(u[OWNER_OF_FIELD] || "").split(/[;|\n]/).map((s) => s.trim()).filter(Boolean));
const fieldSet = (key) => new Set(((S.info[key] && S.info[key].fields) || []).map((f) => f.name.toLowerCase()));
export const layerHasOwner = (key) => fieldSet(key).has(OWNER_FIELD);
export const usersHasOwnerField = () => fieldSet("usr").has(OWNER_OF_FIELD);

/** Owner features are live: table + fields + at least one owner. */
export function ownersActive() {
  return !!S.ownersReady && S.owners.length > 0 && layerHasOwner("bal") && layerHasOwner("txn") && (!S.shipments.ready || layerHasOwner("lines"));
}

/** What is still missing before owners work (for Settings). */
export function ownerSetup() {
  return {
    table: !!S.ownersReady,
    balField: layerHasOwner("bal"), txnField: layerHasOwner("txn"), linesField: layerHasOwner("lines"),
    usersField: usersHasOwnerField(),
    hasOwners: S.owners.length > 0,
  };
}

export const ownerName = (code) => {
  const c = norm(code);
  if (!c) return "";
  const hit = S.owners.find((o) => sameOwner(o.code, c));
  return hit ? hit.name : c;
};

export const myOwnerCodes = () => ownedList(S.myRow);
/** Staff tied to specific groups (not Administrators). */
export const isScoped = () => ownersActive() && !S.isAdmin && myOwnerCodes().length > 0;
/** May the signed-in person receive / move / ship stock owned by `code`? */
export const canActOn = (code) => !isScoped() || myOwnerCodes().some((c) => sameOwner(c, code));
export const canLeaveUnowned = () => !isScoped();
/** Owners offered when receiving. */
export function receiveChoices() {
  if (!ownersActive()) return [];
  return isScoped() ? S.owners.filter((o) => myOwnerCodes().some((c) => sameOwner(c, o.code))) : S.owners;
}
/** Every owner code seen in stock, even ones no longer in the list (for filters). */
export function ownerCodesInUse() {
  const codes = new Map();
  for (const o of S.owners) codes.set(lc(o.code), { code: o.code, name: o.name });
  for (const r of S.balances) { const c = norm(r.property_owner); if (c && !codes.has(lc(c))) codes.set(lc(c), { code: c, name: c }); }
  return [...codes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadOwners() {
  const H = S.shipments;
  S.ownersReady = !!(H.ready && H.ownersId !== null && H.ownersId !== undefined);
  if (!S.ownersReady) { S.owners = []; return; }
  const rows = await queryAll(`${H.url}/${H.ownersId}`, { orderByFields: "name ASC", pageSize: 1000 });
  S.owners = rows.map((r) => ({ ...r, code: norm(r.code), name: norm(r.name) })).filter((r) => r.code);
}

export function ownerUsage(code) {
  const rows = S.balances.filter((r) => sameOwner(r.property_owner, code) && qty(r) > 0);
  return { rows: rows.length, units: rows.reduce((n, r) => n + qty(r), 0), people: S.users.filter((u) => ownedList(u).some((c) => sameOwner(c, code))).length };
}
export const unownedCount = () => S.balances.filter((r) => !norm(r.property_owner) && qty(r) > 0).length;

/** Short, unique, stable code for a new owner (kept even if the name is changed later). */
export function makeOwnerCode(name, taken) {
  const base = (String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "OWNER").slice(0, 30);
  let code = base, n = 2;
  while (taken.has(code.toLowerCase())) { const suf = `-${n++}`; code = base.slice(0, 30 - suf.length) + suf; }
  taken.add(code.toLowerCase());
  return code;
}

/** Saves the Settings list: draft = [{code?, name, old}]. Adds new, renames changed, deletes removed. */
export async function saveOwnerList(draft) {
  const H = S.shipments;
  if (!S.ownersReady) throw new Error("The Owners table isn't set up yet.");
  const list = draft.map((o) => ({ ...o, name: norm(o.name) }));
  if (list.some((o) => !o.name)) throw new Error("Every owner needs a name.");
  if (new Set(list.map((o) => lc(o.name))).size !== list.length) throw new Error("Two owners have the same name.");
  const taken = new Set([...S.owners.map((o) => lc(o.code)), ...list.filter((o) => o.old).map((o) => lc(o.code))]);
  const keep = new Set(list.filter((o) => o.old).map((o) => lc(o.code)));
  const adds = list.filter((o) => !o.old).map((o) => ({ attributes: { code: makeOwnerCode(o.name, taken), name: o.name.slice(0, 120), active: "yes", added_by: S.me.name, added_date: Date.now() } }));
  const updates = list.filter((o) => o.old).map((o) => ({ o, cur: S.owners.find((x) => sameOwner(x.code, o.code)) }))
    .filter((x) => x.cur && x.cur.name !== x.o.name).map((x) => ({ attributes: { OBJECTID: x.cur.OBJECTID ?? x.cur._oid, name: x.o.name.slice(0, 120) } }));
  const deletes = S.owners.filter((o) => !keep.has(lc(o.code))).map((o) => o.OBJECTID ?? o._oid);
  if (!adds.length && !updates.length && !deletes.length) return;
  await applyEdits(`${H.url}/${H.ownersId}`, { adds, updates, deletes });
  await loadOwners();
}

/**
 * Administrator: give existing stock (whole row) an owner. If the target owner already has a row
 * at that item / shelf / lot, the quantities are merged into it. NOT logged as a transaction.
 */
export async function setStockOwner(row, newCode) {
  if (!layerHasOwner("bal")) throw new Error("The Inventory Balance layer has no property_owner field yet (Settings → Add all missing fields).");
  const code = norm(newCode);
  const key = (S.info.bal && S.info.bal.objectIdField) || "OBJECTID";
  const names = fieldSet("bal");
  const fit = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => names.has(k.toLowerCase()) || k === key));
  const same = (a) => ["site", "item_sku", "lot_number"].every((k) => norm(a[k]) === norm(row[k])) && balanceCode(a) === balanceCode(row);
  const target = S.balances.find((r) => r._oid !== row._oid && same(r) && sameOwner(r.property_owner, code));
  const now = Date.now();
  if (target) {
    const onHand = qty(target) + qty(row);
    const alloc = (Number(target.quantity_allocated) || 0) + (Number(row.quantity_allocated) || 0);
    await applyEdits(S.urls.bal, {
      updates: [{ attributes: fit({ [key]: target._oid, quantity_on_hand: onHand, quantity_allocated: alloc, quantity_available: onHand - alloc, last_update: now }) }],
      deletes: [row._oid],
    });
  } else {
    await applyEdits(S.urls.bal, { updates: [{ attributes: fit({ [key]: row._oid, property_owner: code, last_update: now }) }] });
  }
}
