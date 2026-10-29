// ---------------------------------------------------------------------------
// The ArcGIS Online items this app uses, who each is shared with, and whether the signed-in
// account can write to them. Read-only: nothing here changes sharing (that is done in
// ArcGIS Online). Used by the Settings tab.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { esriRequest } from "./shared/esri-client.js";
import { S } from "./state.js";

const portal = () => `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest`;
const get = (url, params = {}) => esriRequest(url, params, { method: "GET" });
const lc = (v) => String(v ?? "").trim().toLowerCase();

export const ACCESS_LABEL = { private: "Private (owner only)", shared: "Shared with groups", org: "Whole organization", public: "Public" };
export const itemPageUrl = (id) => `${CONFIG.ARCGIS_PORTAL_URL}/home/item.html?id=${encodeURIComponent(id)}`;
const USER_TYPES = { creatorUT: "Creator", viewerUT: "Viewer", editorUT: "Editor", fieldWorkerUT: "Field Worker", contributorUT: "Contributor", liteUT: "Lite" };

/** What the layer's own `capabilities` say this account may do. */
export function capsAccess(caps) {
  const c = lc(caps);
  if (!c) return { known: false, edit: false, label: "Not read" };
  const edit = /create|update|delete|editing/.test(c);
  return { known: true, edit, label: edit ? "Can edit" : "View only" };
}

/** The items the app uses, with the layer URL and the capabilities this account has on it. */
export function appItems() {
  const ids = CONFIG.ITEM_IDS || {};
  const caps = (k) => (S.info[k] && S.info[k].raw && S.info[k].raw.capabilities) || "";
  return [
    { key: "bal", label: "Inventory Balance", role: "Stock on hand: one row per item, location, lot and owner", id: ids.balance, url: S.urls.bal, caps: caps("bal"), need: "edit" },
    { key: "txn", label: "Transactions", role: "Every receive, move and ship", id: ids.transactions, url: S.urls.txn, caps: caps("txn"), need: "edit" },
    { key: "lib", label: "Barcode Library", role: "Item catalogue (barcode, unit, gallons)", id: ids.library, url: S.urls.lib, caps: caps("lib"), need: "edit" },
    { key: "ship", label: CONFIG.SHIPMENTS_SERVICE_TITLE, role: "Shipment plans and lines, warehouse users, property owners", id: S.shipments.itemId || CONFIG.SHIPMENTS_ITEM_ID || "", url: S.shipments.url, caps: S.shipments.caps || "", need: "edit" },
    { key: "asg", label: "Assigned Inventory Users", role: "Read only: recognises Inventory Administrators", id: CONFIG.USERS_ITEM_ID || "", url: CONFIG.USERS_LAYER_URL, caps: "", need: "view" },
  ];
}

const cache = new Map(); // item id -> details | {error}
let selfCache = null;
export const cachedDetails = (id) => cache.get(id);
export const cachedSelf = () => selfCache;
export function clearItemCache() { cache.clear(); selfCache = null; }

/** Item facts plus the groups it is shared with. Never throws. */
export async function itemDetails(id) {
  if (cache.has(id)) return cache.get(id);
  let out;
  try {
    const base = `${portal()}/content/items/${encodeURIComponent(id)}`;
    const [item, grp] = await Promise.all([get(base), get(`${base}/groups`).catch(() => null)]);
    const tag = (arr, role) => (arr || []).map((g) => ({ id: g.id, title: g.title || g.id, role, updates: Array.isArray(g.capabilities) ? g.capabilities.includes("updateitemcontrol") : null }));
    out = {
      id, title: item.title || "", type: item.type || "", owner: item.owner || "", access: item.access || "",
      url: String(item.url || "").replace(/\/+$/, ""),
      groups: grp ? [...tag(grp.admin, "admin"), ...tag(grp.member, "member"), ...tag(grp.other, "other")] : null,
    };
  } catch (err) { out = { id, error: err.message }; }
  cache.set(id, out);
  return out;
}

/** The signed-in ArcGIS account: user type and whether its role includes "Edit features". Never throws. */
export async function loadSelf() {
  if (selfCache) return selfCache;
  try {
    const u = await get(`${portal()}/community/self`);
    selfCache = {
      username: u.username || "", fullName: u.fullName || "", role: u.role || "", orgId: u.orgId || "",
      userType: USER_TYPES[u.userLicenseTypeId] || u.userLicenseTypeId || "",
      privileges: Array.isArray(u.privileges) ? u.privileges : null,
    };
  } catch (err) { selfCache = { error: err.message }; }
  return selfCache;
}

export const canEditFeatures = (self) => (self && !self.error && self.privileges ? self.privileges.includes("features:user:edit") : null);

/** The ArcGIS group behind "Add person": title, size, and whether this account is in it. Never throws. */
export async function memberGroupInfo() {
  const id = CONFIG.MEMBER_GROUP_ID;
  if (!id) return null;
  try {
    const base = `${portal()}/community/groups/${encodeURIComponent(id)}`;
    const [g, u, self] = await Promise.all([get(base), get(`${base}/users`).catch(() => null), loadSelf()]);
    const names = u ? [...new Set([u.owner, ...(u.admins || []), ...(u.users || [])].filter(Boolean))] : null;
    return { id, title: g.title || id, owner: g.owner || "", access: g.access || "", count: names ? names.length : null, member: names && self.username ? names.some((n) => lc(n) === lc(self.username)) : null };
  } catch (err) { return { id, error: err.message }; }
}

/** Plain-language reasons an account can't edit a layer, from what ArcGIS will tell us. */
export function editProblems({ d, self }) {
  const out = [];
  if (canEditFeatures(self) === false)
    out.push(`Your ArcGIS role${self.userType ? ` (${self.userType} user type)` : ""} doesn't include the “Edit features” privilege. An organization administrator has to change your role or user type; sharing can't fix this.`);
  if (!d) return out;
  if (d.error) { out.push("Your account can't read this item's sharing (only its owner or an administrator can), so the cause can't be narrowed down here."); return out; }
  const me = lc(self && self.username);
  if (me && lc(d.owner) === me) {
    out.push("You own this item, so sharing isn't the cause. Open it in ArcGIS Online → Settings → Editing and turn on “Enable editing” (add, update and delete features).");
    return out;
  }
  const groups = d.groups;
  const names = (a) => a.map((g) => g.title).join(", ");
  if (groups === null) out.push("The groups it is shared with aren't visible to your account.");
  else if (!groups.length) out.push(`It isn't shared with any group (access: ${ACCESS_LABEL[d.access] || d.access || "unknown"}). Share it with the group that should be able to edit it.`);
  else {
    const mine = groups.filter((g) => g.role !== "other");
    if (!mine.length) out.push(`It is shared with ${names(groups)}, but you aren't a member of any of them. Ask a group owner to add you.`);
    else out.push(`You're in ${names(mine)}, so check that editing is switched on for the item itself (owner: item → Settings → Editing). If it is on and you still can't edit, ArcGIS may require the group to allow members to update items (a “shared update” group); the group's owner can confirm.`);
  }
  if (d.owner) out.push(`Item owner: ${d.owner}. They, or an organization administrator, can fix sharing and editing.`);
  return out;
}
