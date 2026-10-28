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
import { applyEdits, queryAll, searchOrgMembers } from "./shared/esri-client.js";
import { S } from "./state.js";

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
  for (const k of ["email", "username", "full_name", "role", "active", "phone", "notes", "added_by", "added_date"]) if (a[k] !== undefined && a[k] !== null) o[k] = a[k];
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
  host.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Added</th><th></th></tr></thead><tbody>${
    rows.length
      ? rows.map((u) => `<tr class="${isActive(u) ? "" : "row-inactive"}">
          <td><span class="t">${esc(u.full_name || "")}</span>${u.phone ? `<div class="sub">${esc(u.phone)}</div>` : ""}</td>
          <td>${esc(u.email || "")}<div class="sub">${esc(u.username || "")}</div></td>
          <td>${esc(normRole(u.role))}</td>
          <td><span class="status-pill ${isActive(u) ? "st-ok" : "st-muted"}">${isActive(u) ? "Active" : "Off"}</span></td>
          <td class="sub">${esc(fmtDate(u.added_date))}${u.added_by ? `<div>${esc(u.added_by)}</div>` : ""}</td>
          <td class="row-actions"><button type="button" data-act="edit" data-id="${esc(u.OBJECTID ?? u._oid)}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">No one matches.</td></tr>`
  }</tbody></table></div>`;
}

function openUserDialog(row) {
  const editing = !!row;
  const body = `
    ${editing ? "" : `<label>Find in ArcGIS Online <input id="us-find" placeholder="Type a name or username" autocomplete="off" /></label><div id="us-found" class="ip-results"></div>`}
    <div class="two-col">
      <label>Name *<input id="us-name" value="${esc(row ? row.full_name : "")}" /></label>
      <label>Email *<input id="us-email" type="email" value="${esc(row ? row.email : "")}" ${editing ? "readonly" : ""} /></label>
      <label>ArcGIS username<input id="us-username" value="${esc(row ? row.username : "")}" /></label>
      <label>Phone<input id="us-phone" value="${esc(row ? row.phone : "")}" /></label>
    </div>
    <label>Role<select id="us-role">${ROLES.map((r) => `<option value="${esc(r)}" ${row && normRole(row.role) === r ? "selected" : !row && r === "Staff" ? "selected" : ""}>${esc(r)} — ${esc(ROLE_HELP[r])}</option>`).join("")}</select></label>
    ${editing ? `<label class="check"><input id="us-active" type="checkbox" ${isActive(row) ? "checked" : ""} /> Active (can sign in to the app)</label>` : ""}
    <label>Notes<input id="us-notes" value="${esc(row ? row.notes : "")}" /></label>`;
  const buttons = [{ label: "Cancel" }];
  if (editing) buttons.push({ label: "Remove from list", kind: "danger", action: () => remove() });
  buttons.push({ label: editing ? "Save" : "Add person", kind: "primary", action: () => save() });
  const m = openModal({ title: editing ? `Edit ${row.full_name || row.email}` : "Add person", body, buttons });
  const root = m.el;
  const q = (id) => root.querySelector("#" + id);

  if (!editing) {
    const find = q("us-find");
    find.addEventListener("input", debounce(async () => {
      const found = await searchOrgMembers(find.value);
      q("us-found").innerHTML = found.length
        ? found.map((f, i) => `<button type="button" class="ip-opt" data-i="${i}"><strong>${esc(f.fullName)}</strong> <span class="sub">${esc(f.username)}${f.email ? " · " + esc(f.email) : ""}</span></button>`).join("")
        : "";
      q("us-found")._found = found;
    }, 250));
    q("us-found").addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      const f = q("us-found")._found[Number(b.dataset.i)];
      q("us-name").value = f.fullName || "";
      q("us-email").value = f.email || "";
      q("us-username").value = f.username || "";
      q("us-found").innerHTML = "";
    });
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
