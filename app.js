// ---------------------------------------------------------------------------
// LINC Warehouse — startup.
//   1. Sign in with ArcGIS Online (OAuth + PKCE, shared/arcgis-auth.js).
//   2. Resolve the three data layers; "can add transactions" = warehouse staff.
//   3. Load balances, transactions, the Barcode Library, and (if it exists) shipment plans.
//   4. Show Stock / Ship / Transactions (+ Settings for Inventory Administrators).
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { startSession } from "./shared/session.js";
import { $, $$ } from "./shared/util.js";
import { setStatus, toast } from "./shared/ui.js";
import { S } from "./state.js";
import { resolveLayers, loadAllData, loadBalances, loadTransactions, lookupAdmin } from "./data.js";
import { discoverShipments, loadShipments } from "./shipments.js";
import { initStock } from "./stock.js";
import { initPickline } from "./pickline.js";
import { initDrawer } from "./drawer.js";
import { initTransactions } from "./transactions.js";
import { initSettings } from "./settings.js";
import { initLibTab } from "./libtab.js";
import { loadOwners, isScoped, myOwnerCodes, ownerName } from "./owners.js";
import { loadUsers, decideAccess, blockedMessage, addUser, initUsers } from "./users.js";

const TABS = ["stock", "pick", "txn", "lib", "users", "set"];

const tabAllowed = (t) => (t === "set" || t === "users" ? S.isAdmin : true);

function switchTab(tab) {
  if (!tabAllowed(tab)) tab = "stock";
  S.tab = tab;
  $$("#tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of TABS) $(`#screen-${t}`).hidden = t !== tab;
  S.render[tab] && S.render[tab]();
}

function updateBadges() {
  const b = $("#txn-badge");
  if (!b) return;
  const n = S.txns.filter((t) => !["Success", "Voided"].includes(String(t.processing_status || "Pending"))).length;
  b.textContent = n;
  b.hidden = !n;
}

async function refresh({ full = false } = {}) {
  if (full) { await Promise.all([loadBalances(), loadTransactions()]); try { await loadOwners(); } catch (err) { console.info("Owners reload skipped:", err.message); } }
  try { await loadShipments(); } catch (err) { console.warn("Shipments reload failed:", err); }
  S.render[S.tab] && S.render[S.tab]();
  S.render.drawer && S.render.drawer();
  updateBadges();
}

function nameParts(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

async function onReady({ me, profile }) {
  S.profile = profile;
  const np = nameParts(me.name);
  S.me = { name: me.name, first: np.first, last: np.last, email: me.email, username: me.username };

  try {
    setStatus("Loading layers…");
    if (!S.urls.bal) await resolveLayers(); // the sign-in probe already did this
    await loadAllData(setStatus);
  } catch (err) {
    console.error(err);
    return setStatus(`Could not load the layers: ${err.message}`, "error");
  }
  const legacyAdmin = await lookupAdmin(me.email);
  await discoverShipments();
  try { await loadUsers(); } catch (err) { console.warn("Users load failed:", err); S.users = []; }
  try { await loadOwners(); } catch (err) { console.warn("Owners load failed:", err); S.owners = []; S.ownersReady = false; }

  const access = decideAccess({ users: S.users, usersReady: S.usersReady, me: S.me, legacyAdmin });
  if (!access.allowed) {
    setStatus("");
    document.getElementById("not-provisioned-screen").hidden = false;
    $("#not-provisioned-message").textContent = blockedMessage(access, S.me.email);
    return;
  }
  if (access.bootstrap) {
    try { await addUser({ full_name: S.me.name, email: S.me.email, username: S.me.username, role: "Administrator", notes: "First administrator (from Assigned Inventory Users)" }); }
    catch (err) { console.warn("Couldn't add the first administrator to the list:", err); }
  }
  S.role = access.role;
  S.myRow = access.row || null;
  S.isAdmin = S.role === "Administrator";
  S.canEdit = S.role !== "View only" && S.layerCanEdit;

  try { await loadShipments(); } catch (err) { console.warn(err); }

  S.actions.refresh = () => refresh();
  S.actions.switchTab = switchTab;
  S.actions.reloadBalances = async () => { await loadBalances(); await refresh(); };
  initStock(); initPickline(); initDrawer(); initTransactions(); initSettings(); initUsers(); initLibTab();

  $("#user-label").textContent = `${S.me.name} · ${S.role}${isScoped() ? ` · ${myOwnerCodes().map(ownerName).join(", ")}` : ""}${S.role !== "View only" && !S.canEdit ? " (view only)" : ""}`;
  $("#readonly-badge").hidden = S.canEdit;
  for (const b of $$("#tabs .tab-btn")) b.hidden = !tabAllowed(b.dataset.tab);
  $("#tabs").hidden = false;
  $("#reload-btn").hidden = false;
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) switchTab(b.dataset.tab); });
  $("#reload-btn").addEventListener("click", async () => {
    try { await loadAllData(); await refresh(); setStatus(""); toast("Data refreshed.", "success"); } catch (err) { setStatus(err.message, "error"); }
  });

  // Quiet background refresh, skipped while someone is typing or a dialog is open.
  setInterval(async () => {
    if (document.hidden || document.querySelector(".modal-backdrop") || /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || "")) return;
    try { await refresh({ full: true }); } catch (err) { console.info("Background refresh skipped:", err.message); }
  }, CONFIG.REFRESH_MS);

  setStatus("");
  updateBadges();
  switchTab("stock");
  if (!S.canEdit) {
    toast(S.role !== "View only" && !S.layerCanEdit
      ? "Your role allows changes, but your ArcGIS account can't edit the Transactions / Inventory Balance layers. Ask an administrator to share them with editing."
      : "You have view-only access.", "info", 9000);
  }
  if (S.isAdmin && !S.usersReady) toast("Set up the user list: Settings → Add the Users table.", "info", 9000);
}

startSession({
  probe: async () => { await resolveLayers(); },
  noAccessMessage: "Your ArcGIS account can't open the LINC inventory layers. Ask an Inventory Administrator to share them with you.",
  onReady,
});
