// ---------------------------------------------------------------------------
// Settings tab (Inventory Administrators): schema checks against the live layers,
// the shipments service, webhook and pick-line status.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { $, esc } from "./shared/util.js";
import { openModal, toast } from "./shared/ui.js";
import { S } from "./state.js";
import { picklineLanes } from "./loc.js";
import { createShipmentsService, discoverShipments, loadShipments, addUsersTable } from "./shipments.js";
import { loadUsers } from "./users.js";

const NEED = {
  bal: {
    label: "Inventory Balance",
    required: ["site", "location_scan", "zone", "aisle", "bay", "level", "position", "item_sku", "lot_number", "quantity_on_hand", "quantity_available", "last_update"],
    optional: ["unit_of_measure", "category", "item", "make", "model", "description"],
  },
  txn: {
    label: "Transactions",
    required: ["site", "transaction_type", "item_sku", "quantity", "lot", "from_location_scan", "from_zone", "from_row", "from_bay", "from_level", "from_position",
      "to_location_scan", "to_zone", "to_row", "to_bay", "to_level", "to_position", "transaction_datetime", "performed_by", "processing_status", "processing_error"],
    optional: ["shipment_id", "ship_to", "unit_of_measure", "firstname", "lastname"],
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

export function initSettings() {
  const el = $("#screen-set");
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "create-ship") {
      b.disabled = true;
      try {
        const r = await createShipmentsService();
        await discoverShipments();
        await loadShipments();
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
    } else if (b.dataset.act === "add-users") {
      b.disabled = true;
      try {
        await addUsersTable();
        await loadUsers();
        toast("Users table added. Open the Users tab to add people.", "success");
      } catch (err) {
        toast(`Couldn't add it: ${err.message}`, "error", 10000);
      }
      renderSettings();
    } else if (b.dataset.act === "recheck") {
      await discoverShipments();
      await loadShipments();
      renderSettings();
    }
  });
  S.render.set = renderSettings;
}

export function renderSettings() {
  const el = $("#screen-set");
  const lanes = picklineLanes();
  const rep = schemaReport();
  const ship = S.shipments;
  el.innerHTML = `
    <p class="sub set-intro">Admin view. These checks read the live layers; nothing here changes inventory.</p>
    <div class="set-grid">
      <div class="card"><h2>Shipments service</h2>
        ${ship.ready
          ? `<p class="stock-ok">Found and ready.</p><p class="sub">${esc(ship.url)}</p>`
          : `<p>Shipment plans (recipient, ship-to location, lines) are stored in a small hosted service. It hasn't been found yet.</p>
             <div class="set-actions"><button type="button" class="btn-primary" data-act="create-ship">Create the shipments service</button><button type="button" data-act="recheck">Check again</button></div>
             <p class="hint">Needs an ArcGIS account that can publish content. Afterwards, share it with the same group as the inventory layers, with editing on.</p>`}
      </div>
      ${ship.ready ? `<div class="card"><h2>User list</h2>
        ${S.usersReady
          ? `<p class="stock-ok">Users table found · ${S.users.length} ${S.users.length === 1 ? "person" : "people"}.</p><p class="sub">Only people on the list can open the app. Manage them on the Users tab.</p>`
          : `<p>The Users table isn't in the shipments service yet, so anyone who can open the layers gets in. Add it to turn on the user list.</p>
             <div class="set-actions"><button type="button" class="btn-primary" data-act="add-users">Add the Users table</button></div>
             <p class="hint">Needs the account that owns the service. You'll be added as the first administrator if you're an Inventory Administrator in the Assigned Inventory Users layer.</p>`}
      </div>` : ""}
      <div class="card"><h2>Applying to inventory</h2>
        ${CONFIG.APPLY_MODE === "webhook"
          ? (CONFIG.WEBHOOK_URL ? `<p class="stock-ok">Webhook mode: the app calls the Lambda after adding each transaction.</p>` : `<p class="stock-out">Webhook mode, but <code>WEBHOOK_URL</code> isn't set. Transactions will stay Pending.</p>`)
          : `<p class="stock-ok">Browser mode: the app updates Inventory Balance itself, then marks the transaction Success or Error.</p>
             <p class="${S.canEditBalance ? "sub" : "stock-out"}">${S.canEditBalance ? "Your account can edit Inventory Balance." : "Your ArcGIS account can't edit Inventory Balance, so nothing can be applied. A role in this app can't fix that: on the Inventory Balance item in ArcGIS Online, turn on Editing and share it with a group whose members can update."}</p>`}
      </div>
      <div class="card"><h2>Pick line</h2>
        <p>Zone <code>${esc(CONFIG.PICKLINE.ZONE)}</code> · ${lanes.length} lane${lanes.length > 1 ? "s" : ""}</p>
        <p class="sub">${lanes.map((l) => `${esc(l.label)} (scan ${esc(l.code)})`).join("<br>")}</p>
        <p class="hint">Print location labels for each lane. To add lanes, raise <code>PICKLINE.LANES</code> in <code>config.js</code>.</p>
      </div>
      <div class="card"><h2>Your access</h2>
        <p>${esc(S.role)} · ${S.canEdit ? "can add transactions and library items" : "view only"}${S.role !== "View only" && !S.layerCanEdit ? " (the ArcGIS account lacks edit access)" : ""}</p>
        <p class="sub">${esc(S.me.name)} · ${esc(S.me.email)}</p>
      </div>
      ${rep.map((r) => `<div class="card"><h2>${esc(r.label)} fields</h2>
        ${!r.known ? `<p class="sub">Couldn't read the layer's fields.</p>`
          : `${r.missingRequired.length ? `<p class="stock-out">Missing (required): ${r.missingRequired.map((n) => `<code>${esc(n)}</code>`).join(", ")}</p>` : `<p class="stock-ok">All required fields found.</p>`}
             ${r.missingOptional.length ? `<p class="sub">Optional, not on the layer: ${r.missingOptional.map((n) => `<code>${esc(n)}</code>`).join(", ")}</p>` : ""}`}
      </div>`).join("")}
    </div>`;
}
