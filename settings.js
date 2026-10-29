// ---------------------------------------------------------------------------
// Settings tab (Administrators): the ArcGIS items the app uses and how they are shared, why an
// account can't edit, property owners, schema checks, the shipments service, pick-line status.
// Nothing here changes inventory.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { $, esc } from "./shared/util.js";
import { openModal, toast, confirmDialog } from "./shared/ui.js";
import { S } from "./state.js";
import { picklineLanes } from "./loc.js";
import { createShipmentsService, discoverShipments, loadShipments, addUsersTable, addOwnersTable } from "./shipments.js";
import { loadUsers } from "./users.js";
import { missingFields, addMissingFields, LABELS } from "./schemafix.js";
import { ACCESS_LABEL, appItems, capsAccess, itemDetails, itemPageUrl, loadSelf, canEditFeatures, editProblems, memberGroupInfo, clearItemCache, cachedDetails, cachedSelf } from "./items.js";
import { mountLibReview } from "./libreview.js";
import { loadOwners, ownerSetup, ownerUsage, unownedCount, saveOwnerList, ownersActive, ownedList, sameOwner } from "./owners.js";

const NEED = {
  bal: {
    label: "Inventory Balance",
    required: ["site", "location_scan", "zone", "aisle", "bay", "level", "position", "item_sku", "lot_number", "quantity_on_hand", "quantity_available", "last_update"],
    optional: ["unit_of_measure", "category", "item", "make", "model", "description", "property_owner"],
  },
  txn: {
    label: "Transactions",
    required: ["site", "transaction_type", "item_sku", "quantity", "lot", "from_location_scan", "from_zone", "from_row", "from_bay", "from_level", "from_position",
      "to_location_scan", "to_zone", "to_row", "to_bay", "to_level", "to_position", "transaction_datetime", "performed_by", "processing_status", "processing_error"],
    optional: ["shipment_id", "ship_to", "unit_of_measure", "firstname", "lastname", "property_owner"],
  },
  lib: {
    label: "Barcode Library",
    required: ["barcode", "item", "item_category", "make"],
    optional: ["count_unit", "units_per_pack", "unit_volume", "unit_volume_uom", "gallons_per_count_unit", "volume", "Volume_type", "barcode_scan", "barcode_type", "item_barcode"],
  },
};

export function schemaReport() {
  return Object.entries(NEED).map(([key, spec]) => {
    const live = new Set(((S.info[key] && S.info[key].fields) || []).map((f) => f.name.toLowerCase()));
    return {
      label: spec.label,
      missingRequired: spec.required.filter((n) => !live.has(n.toLowerCase())),
      missingOptional: spec.optional.filter((n) => !live.has(n.toLowerCase())),
      known: live.size > 0,
    };
  });
}

let ownerDraft = null; // [{code, name, old}] being edited

// ---- sharing / access rendering ---------------------------------------------------------------
const sharingHtml = (d) => {
  if (!d) return `<span class="sub">Loading…</span>`;
  if (d.error) return `<span class="sub" title="${esc(d.error)}">Not visible to your account</span>`;
  const parts = [];
  if (d.access && d.access !== "shared") parts.push(`<span class="tag tag-muted">${esc(ACCESS_LABEL[d.access] || d.access)}</span>`);
  if (d.groups === null) parts.push(`<span class="sub">Groups not visible to your account</span>`);
  else {
    for (const g of d.groups) {
      parts.push(`<span class="tag" title="${esc(g.title)}${g.role === "other" ? " · you're not in this group" : ""}">${esc(g.title)}${g.role === "other" ? " · not you" : ""}</span>`);
    }
    if (!d.groups.length && !parts.length) parts.push(`<span class="sub">Not shared with any group</span>`);
    else if (!d.groups.length) parts.push(`<span class="sub">No groups</span>`);
  }
  return `<span class="tag-row">${parts.join("")}</span>`;
};
const accessHtml = (it) => {
  const a = capsAccess(it.caps);
  if (!a.known) return `<span class="sub">${it.need === "view" ? "Read only is enough" : "Not read"}</span>`;
  const bad = it.need === "edit" && !a.edit;
  return `<span class="${bad ? "stock-out" : "stock-ok"}" title="${esc(it.caps)}">${a.label}</span>${bad ? `<div class="sub">needs editing</div>` : ""}`;
};

/** Fills the async parts of the page: item sharing, account line, group, "why can't I edit". */
async function fillItems() {
  const self = await loadSelf();
  const acct = document.getElementById("set-acct");
  if (acct) {
    const edit = canEditFeatures(self);
    acct.innerHTML = self.error
      ? `<span class="sub">Couldn't read your ArcGIS account (${esc(self.error)}).</span>`
      : `Signed in as <strong>${esc(self.fullName || self.username)}</strong> <span class="sub">(${esc(self.username)}${self.userType ? " · " + esc(self.userType) + " user type" : ""})</span> · ${
        edit === null ? `<span class="sub">edit privilege not reported</span>` : edit ? `<span class="stock-ok">role includes “Edit features”</span>` : `<span class="stock-out">role does NOT include “Edit features”</span>`}`;
  }
  const items = appItems();
  await Promise.all(items.filter((it) => it.id).map(async (it) => {
    const d = await itemDetails(it.id);
    document.querySelectorAll(`[data-share="${it.id}"]`).forEach((td) => { td.innerHTML = sharingHtml(d); });
    document.querySelectorAll(`[data-meta="${it.id}"]`).forEach((td) => {
      const mismatch = d && !d.error && d.url && it.url && !String(it.url).toLowerCase().startsWith(d.url.toLowerCase());
      td.innerHTML = d.error ? `<span class="sub">—</span>` : `${esc(d.type)}<div class="sub">owner ${esc(d.owner)}</div>${mismatch ? `<div class="stock-out sub">This item's service isn't the layer the app reads. Check the item ID.</div>` : ""}`;
    });
  }));
  document.querySelectorAll("[data-why]").forEach((w) => {
    const probs = editProblems({ d: cachedDetails(w.dataset.why) || null, self });
    w.innerHTML = probs.length ? `<p class="sub"><strong>Likely causes, from what ArcGIS reports:</strong></p><ul class="why-list">${probs.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p class="sub">ArcGIS didn't give a specific reason. Check the item's sharing and editing settings in ArcGIS Online.</p>`;
  });
  const g = await memberGroupInfo();
  const gh = document.getElementById("set-group");
  if (gh && g) {
    gh.innerHTML = g.error
      ? `<span class="sub">Couldn't read the group (${esc(g.error)}).</span>`
      : `<strong>${esc(g.title)}</strong> <span class="sub">· owner ${esc(g.owner)}${g.count != null ? ` · ${g.count} member${g.count === 1 ? "" : "s"}` : ""}</span>
         ${g.member === null ? "" : g.member ? `<span class="tag tag-ok">you're a member</span>` : `<span class="tag tag-muted">you're not a member</span>`}
         <a href="${esc(CONFIG.ARCGIS_PORTAL_URL)}/home/group.html?id=${esc(g.id)}" target="_blank" rel="noopener">Open group</a>`;
  }
}

export function initSettings() {
  const el = $("#screen-set");
  el.addEventListener("input", (e) => { if (e.target.matches("[data-oname]")) syncOwners(); });
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "create-ship") {
      b.disabled = true;
      try {
        const r = await createShipmentsService();
        await discoverShipments();
        await loadShipments();
        await loadOwners();
        openModal({
          title: "Shipments service created",
          body: `<p>Created <strong>${esc(CONFIG.SHIPMENTS_SERVICE_TITLE)}</strong>.</p>
            <ol><li>In ArcGIS Online, <strong>share it</strong> with the same group as the Transactions and Inventory Balance layers, and make sure <strong>editing is on</strong>, so warehouse staff can add and update plans.</li>
            <li>Optional: paste its item ID <code>${esc(r.itemId || "")}</code> into <code>SHIPMENTS_ITEM_ID</code> in <code>config.js</code> so the app doesn't need to look it up by title.</li></ol>`,
          buttons: [{ label: "Done", kind: "primary" }],
        });
      } catch (err) {
        toast(`Couldn't create it: ${err.message}`, "error", 10000);
      }
      renderSettings();
    } else if (act === "add-fields") {
      b.disabled = true;
      const keys = b.dataset.key === "all" ? Object.keys(missingFields()) : [b.dataset.key];
      const done = [];
      try {
        for (const k of keys) { const added = await addMissingFields(k); if (added.length) done.push(`${LABELS[k]}: ${added.join(", ")}`); }
        toast(done.length ? `Added ${done.join(" · ")}` : "Nothing to add.", "success", 9000);
        if (done.length) { await loadUsers().catch(() => {}); await loadOwners().catch(() => {}); }
      } catch (err) {
        toast(`Couldn't add fields: ${err.message}. This needs the account that owns the layers (or an org administrator).`, "error", 12000);
      }
      renderSettings();
    } else if (act === "add-users") {
      b.disabled = true;
      try {
        await addUsersTable();
        await loadUsers();
        toast("Users table added. Open the Users tab to add people.", "success");
      } catch (err) {
        toast(`Couldn't add it: ${err.message}`, "error", 10000);
      }
      renderSettings();
    } else if (act === "add-owners-table") {
      b.disabled = true;
      try {
        await addOwnersTable();
        await loadOwners();
        toast("Owners table added. Add your groups below.", "success");
      } catch (err) {
        toast(`Couldn't add it: ${err.message}. This needs the account that owns the shipments service (or an org administrator).`, "error", 10000);
      }
      renderSettings();
    } else if (act === "recheck") {
      await discoverShipments();
      await loadShipments();
      await loadOwners().catch(() => {});
      renderSettings();
    } else if (act === "recheck-sharing") {
      clearItemCache();
      renderSettings();
    } else if (act === "owner-add") {
      syncOwners(); ownerDraft.push({ code: "", name: "", old: false }); renderSettings(); $("#set-owners li:last-child input")?.focus();
    } else if (act === "owner-del") {
      syncOwners(); await removeOwner(Number(b.dataset.i));
    } else if (act === "owner-reset") {
      ownerDraft = null; renderSettings();
    } else if (act === "owner-save") {
      syncOwners();
      b.disabled = true;
      try {
        await saveOwnerList(ownerDraft);
        ownerDraft = null;
        toast("Property owners saved.", "success");
        S.actions.refresh && S.actions.refresh();
      } catch (err) { toast(`Couldn't save the list: ${err.message}`, "error", 9000); b.disabled = false; return; }
      renderSettings();
    }
  });
  S.render.set = renderSettings;
}

function syncOwners() {
  if (!ownerDraft) return;
  document.querySelectorAll("#set-owners input[data-oname]").forEach((inp) => { const o = ownerDraft[Number(inp.dataset.oname)]; if (o) o.name = inp.value; });
}

async function removeOwner(i) {
  const o = ownerDraft[i];
  if (o.old) {
    const u = ownerUsage(o.code);
    if (u.rows || u.people) {
      const yes = await confirmDialog({ title: `Remove ${o.name}?`, message: `${u.rows} stock row${u.rows === 1 ? "" : "s"} and ${u.people} person${u.people === 1 ? "" : "s"} still use it. They keep the code, but it will no longer have a name. Remove it from the list anyway? (Nothing changes until you press Save list.)`, confirmLabel: "Remove", kind: "danger" });
      if (!yes) return;
    }
  }
  ownerDraft.splice(i, 1);
  renderSettings();
}

const step = (ok, text, action = "") => `<li class="${ok ? "stock-ok" : "stock-out"}">${ok ? "✓" : "✗"} ${text}${!ok && action ? ` ${action}` : ""}</li>`;

function ownersCard() {
  const su = ownerSetup();
  const fieldsFix = !S.canEdit ? "" : `<button type="button" class="link-btn" data-act="add-fields" data-key="all">Add all missing fields</button>`;
  const ready = su.table;
  ownerDraft = ownerDraft || S.owners.map((o) => ({ code: o.code, name: o.name, old: true }));
  const list = ready ? `<ul class="set-list" id="set-owners">${ownerDraft.map((o, i) => {
      const u = o.old ? ownerUsage(o.code) : null;
      return `<li class="set-row">
        <input class="set-input" data-oname="${i}" value="${esc(o.name)}" maxlength="120" aria-label="Property owner name" placeholder="Group name" />
        <span class="mono sub">${o.old ? esc(o.code) : "new"}</span>
        <span class="sub set-used">${u ? `${u.rows} stock row${u.rows === 1 ? "" : "s"} · ${u.people} ${u.people === 1 ? "person" : "people"}` : ""}</span>
        <button type="button" class="icon-btn" data-act="owner-del" data-i="${i}" aria-label="Remove">&times;</button></li>`;
    }).join("") || `<li class="sub">No owners yet.</li>`}</ul>
    <div class="set-actions"><button type="button" data-act="owner-add">+ Add group</button><span class="spacer"></span>
      <button type="button" data-act="owner-reset">Discard changes</button>
      <button type="button" class="btn-primary" data-act="owner-save">Save list</button></div>
    <p class="sub">${unownedCount()} stock row${unownedCount() === 1 ? " has" : "s have"} no owner yet. Give existing stock an owner from the Stock tab (<strong>Owner</strong> button on each row). Renaming a group is safe: stock and people are linked by its code.</p>` : "";
  return `<div class="card set-wide"><h2>Property owners</h2>
    <p class="sub">Some consumables are received and managed by different groups. Each stock row and transaction records its <b>property owner</b>. People tied to a group (Users tab → Edit person) can receive, move, stage and ship only that group's stock; administrators and staff with no group can handle everything. Everyone can still view all stock. The same item on the same shelf owned by two groups is kept as two rows, so counts never mix.</p>
    <ul class="set-checks">
      ${step(su.table, "Owners table in the shipments service", `<button type="button" class="link-btn" data-act="add-owners-table" ${S.shipments.ready ? "" : "disabled"}>Add the Owners table</button>`)}
      ${step(su.balField && su.txnField && (su.linesField || !S.shipments.ready), "<code>property_owner</code> on Inventory Balance, Transactions and Shipment lines", fieldsFix)}
      ${step(su.usersField, "<code>property_owner_of</code> on the warehouse Users table (so people can be tied to groups)", fieldsFix)}
      ${step(su.hasOwners, "At least one group below")}
    </ul>
    ${ownersActive() ? `<p class="banner banner-ok">Property owners are on.</p>` : `<p class="banner banner-warn">Property owners are off until every step above is ✓. Nothing changes for anyone until then.</p>`}
    ${list}
    <p class="hint">Adding the table and fields needs the ArcGIS account that owns the layers (or an org administrator). If Transactions comes from a Survey123 form, add <code>property_owner</code> to the survey too, or republishing can remove it. Webhook mode and the old Survey123 form don't know about owners: what they write has no owner.</p></div>`;
}

/** Problems worth the admin's attention, each with an explanation and (where possible) a fix button. */
function issues() {
  const out = [];
  const items = appItems();
  for (const it of items) {
    if (it.need !== "edit" || it.key === "ship") continue;
    const a = capsAccess(it.caps);
    if (!S.info[it.key]) out.push({ title: `Couldn't read ${it.label}`, body: "The app couldn't open this layer, so features that use it won't work. Check that the item ID in config.js is right and that the item is shared with you.", why: it.id });
    else if (a.known && !a.edit) out.push({
      title: `Your account can't edit ${it.label}`,
      body: it.key === "bal" ? "ArcGIS reports view-only access for you, so transactions can't be applied to stock." : it.key === "txn" ? "ArcGIS reports view-only access for you, so you can't add receive, move or ship transactions." : "ArcGIS reports view-only access for you, so you can't add or change library items.",
      why: it.id,
    });
  }
  if (CONFIG.APPLY_MODE === "webhook" && !CONFIG.WEBHOOK_URL) out.push({ title: "Webhook URL isn't set", body: "APPLY_MODE is “webhook” but WEBHOOK_URL is empty in config.js, so transactions will stay Pending." });
  if (!S.shipments.ready) out.push({ title: "Shipments service not found", body: "Shipment plans, the user list and property owners are stored in a small hosted service that hasn't been found yet. It needs an ArcGIS account that can publish content; afterwards share it with the same group as the inventory layers, with editing on.", actions: `<button type="button" class="btn-primary" data-act="create-ship">Create the shipments service</button> <button type="button" data-act="recheck">Check again</button>` });
  else if (!S.usersReady) out.push({ title: "User list not set up", body: "Without the Users table, anyone who can open the layers gets in. Needs the account that owns the shipments service.", actions: `<button type="button" class="btn-primary" data-act="add-users">Add the Users table</button>` });
  for (const r of schemaReport()) {
    if (!r.known) out.push({ title: `Couldn't read the ${r.label} fields`, body: "The layer's field list couldn't be read." });
    else if (r.missingRequired.length) out.push({ title: `${r.label} is missing required fields`, body: `Missing: ${r.missingRequired.map((n) => `<code>${esc(n)}</code>`).join(", ")}. The app can't work correctly until these exist (they come from the Survey123 form or the layer's design).`, raw: true });
  }
  const miss = missingFields();
  if (Object.keys(miss).length) out.push({
    title: "Some fields the app uses are missing",
    body: `${Object.entries(miss).map(([k, f]) => `<strong>${esc(LABELS[k])}</strong>: ${f.map((x) => `<code>${esc(x.name)}</code>`).join(", ")}`).join("<br>")}<br><span class="hint">Adds fields only; nothing is changed or deleted. Needs the account that owns the layers (or an org administrator). If a layer comes from a Survey123 form, add the same fields to the survey too, or republishing can remove them.</span>`,
    raw: true,
    actions: `<button type="button" class="btn-primary" data-act="add-fields" data-key="all">Add all missing fields</button>`,
  });
  return out;
}

export function renderSettings() {
  const el = $("#screen-set");
  const lanes = picklineLanes();
  const rep = schemaReport();
  const ship = S.shipments;
  const items = appItems();
  const list = issues();
  const itemRows = items.map((it) => `<tr>
      <td><span class="t">${esc(it.label)}</span><div class="sub">${esc(it.role)}</div></td>
      <td>${it.id ? `<span class="mono">${esc(it.id)}</span>` : `<span class="sub">${it.key === "ship" ? "Not found yet" : "Not set"}</span>`}</td>
      <td data-meta="${esc(it.id)}"><span class="sub">${it.id ? "Loading…" : ""}</span></td>
      <td data-share="${esc(it.id)}">${it.id ? sharingHtml(cachedDetails(it.id)) : `<span class="sub">—</span>`}</td>
      <td>${accessHtml(it)}</td>
      <td>${it.id ? `<a href="${esc(itemPageUrl(it.id))}" target="_blank" rel="noopener">Open item</a>` : ""}</td></tr>`).join("");
  const issuesCard = list.length
    ? `<div class="card set-wide issues-card"><h2>Needs attention <span class="tag tag-restricted">${list.length}</span></h2>
        <ul class="issue-list">${list.map((i) => `<li class="issue"><strong>${esc(i.title)}</strong>
          <p class="sub">${i.raw ? i.body : esc(i.body)}</p>
          ${i.why ? `<div data-why="${esc(i.why)}"><span class="sub">Checking why…</span></div>` : ""}
          ${i.actions ? `<div class="set-actions">${i.actions}</div>` : ""}</li>`).join("")}</ul></div>`
    : `<div class="card set-wide"><h2>Setup check</h2><p class="stock-ok">✓ No problems found. Your account can edit the layers, the shipments service and user list are set up, and all required fields exist.</p></div>`;
  el.innerHTML = `
    <p class="sub set-intro">Admin view. Nothing here changes inventory. Sharing and editing are changed in ArcGIS Online, not here.</p>
    ${issuesCard}
    <div class="card set-wide"><h2>ArcGIS items and sharing</h2>
      <p class="sub">The ArcGIS Online items this app reads and writes, and who they are shared with. Warehouse staff need <strong>edit</strong> access to Transactions and Inventory Balance (and the Barcode Library to add items): the item must be shared with a group they belong to, with editing enabled on the item. “Your access” is what your own account can do today, and is the column to trust.</p>
      <p id="set-acct" class="set-acct"><span class="sub">Reading your ArcGIS account…</span></p>
      <div class="table-wrap"><table class="grid"><thead><tr><th>Item</th><th>Item ID</th><th>Type / owner</th><th>Shared with</th><th>Your access</th><th></th></tr></thead><tbody>${itemRows}</tbody></table></div>
      ${CONFIG.MEMBER_GROUP_ID ? `<p class="set-group-line"><span class="sub">“Add person” group:</span> <span id="set-group"><span class="sub">Loading…</span></span></p>` : ""}
      <div class="set-actions"><button type="button" data-act="recheck-sharing">Re-check sharing</button></div></div>
    ${ownersCard()}
    <div id="lr-host" class="set-wide lr-host"></div>
    <details class="card set-wide set-details"><summary>Status details</summary>
      <div class="set-grid" style="margin-top:.8rem">
        <div class="card"><h2>Your access</h2>
          <p>${esc(S.role)} · ${S.canEdit ? "can add transactions and library items" : "view only"}${S.role !== "View only" && !S.layerCanEdit ? " (the ArcGIS account lacks edit access)" : ""}</p>
          <p class="sub">${esc(S.me.name)} · ${esc(S.me.email)}</p>
          ${ownersActive() ? `<p class="sub">${S.isAdmin ? "Property owners: all groups." : ownedList(S.myRow).length ? `Property owners: only ${esc(ownedList(S.myRow).map((c) => (S.owners.find((o) => sameOwner(o.code, c)) || { name: c }).name).join(", "))}.` : "Property owners: all groups (no group set for you)."}</p>` : ""}
          <p class="sub">${CONFIG.APPLY_MODE === "webhook" ? "Applying: webhook mode." : "Applying: the app updates Inventory Balance itself (browser mode)."}</p></div>
        <div class="card"><h2>Shipments service</h2>
          ${ship.ready ? `<p class="stock-ok">Found and ready.</p><p class="sub">${esc(ship.url)}</p>` : `<p class="stock-out">Not found yet.</p>`}</div>
        ${ship.ready ? `<div class="card"><h2>User list</h2>${S.usersReady ? `<p class="stock-ok">Users table found · ${S.users.length} ${S.users.length === 1 ? "person" : "people"}.</p><p class="sub">Only people on the list can open the app. Manage them on the Users tab.</p>` : `<p class="stock-out">Users table not set up.</p>`}</div>` : ""}
        <div class="card"><h2>Pick line</h2>
          <p>Zone <code>${esc(CONFIG.PICKLINE.ZONE)}</code> · ${lanes.length} lane${lanes.length > 1 ? "s" : ""}</p>
          <p class="sub">${lanes.map((l) => `${esc(l.label)} (scan ${esc(l.code)})`).join("<br>")}</p>
          <p class="hint">Print location labels for each lane. To add lanes, raise <code>PICKLINE.LANES</code> in <code>config.js</code>.</p></div>
        ${rep.map((r) => `<div class="card"><h2>${esc(r.label)} fields</h2>
          ${!r.known ? `<p class="sub">Couldn't read the layer's fields.</p>`
            : `${r.missingRequired.length ? `<p class="stock-out">Missing (required): ${r.missingRequired.map((n) => `<code>${esc(n)}</code>`).join(", ")}</p>` : `<p class="stock-ok">All required fields found.</p>`}
               ${r.missingOptional.length ? `<p class="sub">Optional, not on the layer: ${r.missingOptional.map((n) => `<code>${esc(n)}</code>`).join(", ")}</p>` : ""}`}</div>`).join("")}
      </div></details>`;
  mountLibReview();
  fillItems().catch((err) => console.info("Settings: item details unavailable:", err.message));
}
