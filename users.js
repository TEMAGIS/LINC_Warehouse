// ---------------------------------------------------------------------------
// The warehouse user list: who may use this app, and as what.
//   Administrator  everything, plus the Users and Settings tabs
//   Staff          receive, move, stage, shipment plans, ship, add to the Barcode Library
//   View only      can look, can't change anything
// The list is the `Users` table in the shipments service. It decides what the APP offers.
// ArcGIS sharing still decides what an account may actually write: staff need edit access
// to the Transactions and Inventory Balance layers (Settings → "Your access" shows this).
// ---------------------------------------------------------------------------
import { $, esc, debounce, fmtDate } from "./shared/util.js";
import { openModal, confirmDialog, toast } from "./shared/ui.js";
import { applyEdits, queryAll, searchOrgMembers, esriRequest } from "./shared/esri-client.js";
import { CONFIG } from "./config.js";
import { S } from "./state.js";
import { ownedList, ownerName, usersHasOwnerField, ownersActive } from "./owners.js";

let groupCache = null;
/** "sarah.matson@tn.gov" -> "Sarah Matson" (used when ArcGIS has no real full name for the account). */
export function niceName(p) {
  const fn = String(p.fullName || "").trim();
  if (fn && fn.toLowerCase() !== String(p.username || "").toLowerCase() && !fn.includes("@")) return fn;
  const local = String(p.email || p.username || "").split("@")[0].replace(/_[a-z]+$/i, "");
  return local.split(/[._\-\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || fn;
}

async function loadGroup() {
  if (groupCache) return groupCache;
  const base = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/community`;
  const g = await esriRequest(`${base}/groups/${CONFIG.MEMBER_GROUP_ID}/users`, {}, { method: "GET" });
  const names = [...new Set([g.owner, ...(g.admins || []), ...(g.users || [])].filter(Boolean))];
  groupCache = (await Promise.all(names.map(async (username) => {
    try {
      const u = await esriRequest(`${base}/users/${encodeURIComponent(username)}`, {}, { method: "GET" });
      return { username, fullName: u.fullName || username, email: u.email || (username.includes("@") ? username : "") };
    } catch { return { username, fullName: username, email: username.includes("@") ? username : "" }; }
  }))).map((p) => ({ ...p, fullName: niceName(p) })).sort((x, y) => x.fullName.localeCompare(y.fullName));
  return groupCache;
}
/** Start loading the group in the background (called when Add person opens). */
export function warmGroup() { if (CONFIG.MEMBER_GROUP_ID && !groupCache) loadGroup().catch(() => {}); }

/**
 * People to offer in "Add person". With CONFIG.MEMBER_GROUP_ID set, only members of that ArcGIS
 * group (owner, admins, users); otherwise anyone in the organization. Returns
 * {people, restricted, error}. Group members are loaded once, then filtered by the typed text
 * (an empty box lists the first few, since the group is small).
 */
export async function findPeople(text) {
  const t = lc(text);
  if (!CONFIG.MEMBER_GROUP_ID) return t.length < 2 ? { people: [], restricted: false } : { people: (await searchOrgMembers(text)).map((p) => ({ ...p, fullName: niceName(p) })), restricted: false };
  try {
    const all = await loadGroup();
    const hits = t ? all.filter((p) => `${p.fullName} ${p.username} ${p.email}`.toLowerCase().includes(t)) : all;
    return { people: hits.slice(0, 8), more: Math.max(0, hits.length - 8), restricted: true };
  } catch (err) {
    groupCache = null;
    return { people: [], restricted: true, error: err.message };
  }
}

export const ROLES = ["Administrator", "Staff", "View only"];
export const ROLE_HELP = {
  Administrator: "Everything, plus Users and Settings",
  Staff: "Receive, move, stage, shipment plans, ship, add to library",
  "View only": "Look, but change nothing",
};

const lc = (v) => String(v ?? "").trim().toLowerCase();
export const isActive = (u) => lc(u.active) !== "no";
export const normRole = (r) => ROLES.find((x) => lc(x) === lc(r)) || "View only";

/** The list row for the signed-in person: by email, else by ArcGIS username. */
export function findUserRow(users, me) {
  const email = lc(me.email);
  const name = lc(me.username);
  return users.find((u) => email && lc(u.email) === email) || users.find((u) => name && lc(u.username) === name) || null;
}

export const activeAdmins = (users) => users.filter((u) => isActive(u) && normRole(u.role) === "Administrator");

/**
 * Decides whether this person gets in, and as what.
 *  - No Users table yet: nothing to check. An Inventory Administrator of the Assigned Inventory
 *    Users layer is an Administrator, everyone else Staff (the old behaviour).
 *  - On the list and active: their role.
 *  - Not on the list: blocked, except the list's bootstrap: when it has NO active administrator,
 *    an Inventory Administrator from the Assigned Inventory Users layer gets in as Administrator
 *    (and is added to the list).
 */
export function decideAccess({ users, usersReady, me, legacyAdmin }) {
  if (!usersReady) return { allowed: true, role: legacyAdmin ? "Administrator" : "Staff", managed: false };
  const row = findUserRow(users, me);
  if (row && isActive(row)) return { allowed: true, role: normRole(row.role), managed: true, row };
  if (row && !isActive(row)) return { allowed: false, managed: true, reason: "inactive" };
  if (!activeAdmins(users).length && legacyAdmin) return { allowed: true, role: "Administrator", managed: true, bootstrap: true };
  return { allowed: false, managed: true, reason: "not listed" };
}

export const blockedMessage = (d, email) =>
  d.reason === "inactive"
    ? `Your warehouse access (${email}) is turned off. Ask an administrator to turn it back on.`
    : `${email} isn't on the LINC Warehouse user list yet. Ask an administrator to add you.`;

const usersUrl = () => `${S.shipments.url}/${S.shipments.usersId}`;

export async function loadUsers() {
  if (!S.usersReady) { S.users = []; return; }
  S.users = await queryAll(usersUrl(), { orderByFields: "full_name ASC", pageSize: 1000 });
}

const clean = (a) => {
  const o = {};
  for (const k of ["email", "username", "full_name", "role", "active", "phone", "notes", "property_owner_of", "added_by", "added_date"]) if (a[k] !== undefined && a[k] !== null) o[k] = a[k];
  return o;
};

export async function addUser(attrs) {
  const email = lc(attrs.email);
  if (!email) throw new Error("Enter an email address.");
  if (!String(attrs.full_name || "").trim()) throw new Error("Enter a name.");
  if (S.users.some((u) => lc(u.email) === email)) throw new Error(`${email} is already on the list.`);
  await applyEdits(usersUrl(), { adds: [{ attributes: clean({ active: "yes", role: "Staff", ...attrs, email, added_by: S.me.name, added_date: Date.now() }) }] });
  await loadUsers();
}

export async function updateUser(row, patch) {
  const oid = row.OBJECTID ?? row._oid;
  await applyEdits(usersUrl(), { updates: [{ attributes: { ...clean(patch), OBJECTID: oid } }] });
  await loadUsers();
}

export async function removeUser(row) {
  await applyEdits(usersUrl(), { deletes: [row.OBJECTID ?? row._oid] });
  await loadUsers();
}

/** Would this change leave the list without an active administrator? */
export function wouldOrphanAdmins(row, patch = null) {
  const others = activeAdmins(S.users).filter((u) => (u.OBJECTID ?? u._oid) !== (row.OBJECTID ?? row._oid));
  if (others.length) return false;
  const stillAdmin = patch ? normRole(patch.role ?? row.role) === "Administrator" && lc(patch.active ?? row.active) !== "no" : false;
  return !stillAdmin;
}

// ---------------------------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------------------------
const F = { q: "" };

export function initUsers() {
  const el = $("#screen-users");
  el.addEventListener("input", debounce((e) => { if (e.target.id === "us-q") { F.q = e.target.value; renderRows(); } }, 150));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "add") openUserDialog(null);
    else if (b.dataset.act === "edit") openUserDialog(S.users.find((u) => String(u.OBJECTID ?? u._oid) === b.dataset.id));
  });
  S.render.users = renderUsers;
}

export function renderUsers() {
  const el = $("#screen-users");
  if (!S.usersReady) {
    el.innerHTML = `<div class="banner banner-warn">The user list needs its table. ${S.isAdmin ? "Open <strong>Settings</strong> and choose <strong>Add the Users table</strong> (or create the shipments service)." : "Ask an administrator."}</div>`;
    return;
  }
  const n = S.users.filter(isActive).length;
  el.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="tile-n">${n}</div><div class="tile-l">Active people</div></div>
      ${ROLES.map((r) => `<div class="tile"><div class="tile-n">${S.users.filter((u) => isActive(u) && normRole(u.role) === r).length}</div><div class="tile-l">${esc(r)}</div></div>`).join("")}
    </div>
    <div class="toolbar">
      <input id="us-q" type="search" placeholder="Name or email" value="${esc(F.q)}" aria-label="Search people" />
      <span class="spacer"></span>
      <button type="button" class="btn-primary" data-act="add">Add person</button>
    </div>
    <div id="us-table"></div>
    <p class="hint">This list decides what the app offers each person. ArcGIS sharing still decides what their account can write: staff also need edit access to the Transactions and Inventory Balance layers.</p>`;
  renderRows();
}

function renderRows() {
  const host = $("#us-table");
  if (!host) return;
  const t = lc(F.q);
  const rows = S.users.filter((u) => !t || `${u.full_name} ${u.email} ${u.username}`.toLowerCase().includes(t));
  host.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Email</th><th>Role</th>${S.ownersReady ? "<th>Property owner of</th>" : ""}<th>Status</th><th>Added</th><th></th></tr></thead><tbody>${
    rows.length
      ? rows.map((u) => `<tr class="${isActive(u) ? "" : "row-inactive"}">
          <td><span class="t">${esc(u.full_name || "")}</span>${u.phone ? `<div class="sub">${esc(u.phone)}</div>` : ""}</td>
          <td>${esc(u.email || "")}<div class="sub">${esc(u.username || "")}</div></td>
          <td>${esc(normRole(u.role))}</td>
          ${S.ownersReady ? `<td class="sub">${normRole(u.role) === "Administrator" ? "All groups" : ownedList(u).map((c) => esc(ownerName(c))).join(", ") || "All (no group set)"}</td>` : ""}
          <td><span class="status-pill ${isActive(u) ? "st-ok" : "st-muted"}">${isActive(u) ? "Active" : "Off"}</span></td>
          <td class="sub">${esc(fmtDate(u.added_date))}${u.added_by ? `<div>${esc(u.added_by)}</div>` : ""}</td>
          <td class="row-actions"><button type="button" data-act="edit" data-id="${esc(u.OBJECTID ?? u._oid)}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="${S.ownersReady ? 7 : 6}" class="empty">No one matches.</td></tr>`
  }</tbody></table></div>`;
}

function openUserDialog(row) {
  const editing = !!row;
  const body = `
    ${editing ? "" : `<label>Find in ${CONFIG.MEMBER_GROUP_ID ? "the warehouse group" : "ArcGIS Online"} <input id="us-find" placeholder="Type a name or username" autocomplete="off" /></label><div id="us-found" class="ip-results"></div>`}
    <div class="two-col">
      <label>Name *<input id="us-name" value="${esc(row ? row.full_name : "")}" /></label>
      <label>Email *<input id="us-email" type="email" value="${esc(row ? row.email : "")}" ${editing ? "readonly" : ""} /></label>
      <label>ArcGIS username<input id="us-username" value="${esc(row ? row.username : "")}" /></label>
      <label>Phone<input id="us-phone" value="${esc(row ? row.phone : "")}" /></label>
    </div>
    <label>Role<select id="us-role">${ROLES.map((r) => `<option value="${esc(r)}" ${row && normRole(row.role) === r ? "selected" : !row && r === "Staff" ? "selected" : ""}>${esc(r)} — ${esc(ROLE_HELP[r])}</option>`).join("")}</select></label>
    ${editing ? `<label class="check"><input id="us-active" type="checkbox" ${isActive(row) ? "checked" : ""} /> Active (can sign in to the app)</label>` : ""}
    ${ownerPicker(row)}
    <label>Notes<input id="us-notes" value="${esc(row ? row.notes : "")}" /></label>`;
  const buttons = [{ label: "Cancel" }];
  if (editing) buttons.push({ label: "Remove from list", kind: "danger", action: () => remove() });
  buttons.push({ label: editing ? "Save" : "Add person", kind: "primary", action: () => save() });
  const m = openModal({ title: editing ? `Edit ${row.full_name || row.email}` : "Add person", body, buttons });
  const root = m.el;
  const q = (id) => root.querySelector("#" + id);

  if (!editing) {
    const find = q("us-find");
    const found = q("us-found");
    const onList = (f) => S.users.some((u) => (f.email && lc(u.email) === lc(f.email)) || (f.username && lc(u.username) === lc(f.username)));
    let seq = 0;
    const show = async () => {
      const mine = ++seq;
      const text = find.value;
      if (CONFIG.MEMBER_GROUP_ID && !groupCache) found.innerHTML = `<div class="sub">Loading the warehouse group…</div>`;
      const res = await findPeople(text);
      if (mine !== seq) return; // a newer keystroke is already being answered
      found._found = res.people;
      found.innerHTML = res.error
        ? `<div class="sub">Couldn't read the group: ${esc(res.error)}. Type the details below.</div>`
        : !res.people.length
          ? (lc(text).length >= (CONFIG.MEMBER_GROUP_ID ? 1 : 2)
              ? `<div class="sub">${res.restricted ? "No match in the warehouse group. Ask an ArcGIS administrator to add them to the group first, or type the details below." : "No match."}</div>` : "")
          : res.people.map((f, i) => `<button type="button" class="ip-opt${i === 0 ? " ip-first" : ""}" data-i="${i}" ${onList(f) ? "disabled" : ""}><strong>${esc(f.fullName)}</strong> <span class="sub">${esc(f.email || f.username)}${onList(f) ? " · already on the list" : ""}</span></button>`).join("")
            + (res.more ? `<div class="sub">${res.more} more. Keep typing to narrow it down.</div>` : "");
    };
    const pick = (f) => {
      if (!f || onList(f)) return;
      q("us-name").value = f.fullName || "";
      q("us-email").value = f.email || "";
      q("us-username").value = f.username || "";
      find.value = "";
      found._found = [];
      found.innerHTML = `<div class="ip-picked"><span>Selected <strong>${esc(f.fullName)}</strong> <span class="sub">${esc(f.email || f.username)}</span></span><button type="button" data-again>Change</button></div>`;
      (q("us-role") || {}).focus && q("us-role").focus();
    };
    warmGroup();
    find.addEventListener("input", debounce(show, 150));
    find.addEventListener("focus", () => { if (CONFIG.MEMBER_GROUP_ID && !find.value) show(); });
    find.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault(); // Enter picks the top match instead of submitting
      const f = (found._found || []).find((x) => !onList(x));
      if (f) pick(f);
    });
    found.addEventListener("click", (e) => {
      if (e.target.closest("[data-again]")) { found.innerHTML = ""; find.focus(); return; }
      const b = e.target.closest("[data-i]");
      if (b) pick((found._found || [])[Number(b.dataset.i)]);
    });
    find.focus();
  }

  async function save() {
    const attrs = {
      full_name: q("us-name").value.trim(),
      email: q("us-email").value.trim(),
      username: q("us-username").value.trim(),
      phone: q("us-phone").value.trim(),
      role: q("us-role").value,
      notes: q("us-notes").value.trim(),
    };
    if (root.querySelector("[data-owner-code]")) {
      const codes = [...root.querySelectorAll("[data-owner-code]:checked")].map((x) => x.dataset.ownerCode);
      attrs.property_owner_of = codes.join("; ");
      if (attrs.property_owner_of.length > 250) throw new Error("That's too many groups to store for one person.");
    }
    if (!editing) {
      await addUser(attrs);
      toast("Person added.", "success");
    } else {
      const patch = { ...attrs, active: q("us-active").checked ? "yes" : "no" };
      if (wouldOrphanAdmins(row, patch)) throw new Error("That would leave no active administrator. Make someone else an administrator first.");
      await updateUser(row, patch);
      toast("Saved.", "success");
    }
    S.render.users && S.render.users();
  }

  async function remove() {
    if (wouldOrphanAdmins(row)) throw new Error("That's the last active administrator. Make someone else an administrator first.");
    const ok = await confirmDialog({ title: "Remove from the list?", message: `${row.full_name || row.email} will lose access to the app. (Turn off “Active” instead to keep the record.)`, confirmLabel: "Remove", kind: "danger" });
    if (!ok) return false;
    await removeUser(row);
    toast("Removed.", "success");
    S.render.users && S.render.users();
  }
  return m;
}

/** "Property owner of" checkboxes for the person dialog (only when the Owners table and the Users field exist). */
function ownerPicker(row) {
  if (!S.ownersReady) return "";
  if (!usersHasOwnerField()) return `<p class="hint">To tie people to property owner groups, add the <code>property_owner_of</code> field (Settings → Add all missing fields).</p>`;
  if (!S.owners.length) return `<p class="hint">No property owner groups yet (Settings → Property owners).</p>`;
  const mine = new Set(ownedList(row).map((c) => c.toLowerCase()));
  return `<fieldset><legend>Property owner of</legend>
    <div class="check-grid">${S.owners.map((o) => `<label class="check"><input type="checkbox" data-owner-code="${esc(o.code)}" ${mine.has(o.code.toLowerCase()) ? "checked" : ""} /> ${esc(o.name)}</label>`).join("")}</div>
    <p class="hint">Tick the groups this person manages. Group staff can receive, move, stage and ship only those groups' stock. Leave empty for general warehouse staff (all stock). Administrators always handle everything.${ownersActive() ? "" : " Property owners aren't switched on yet (Settings)."}</p></fieldset>`;
}
