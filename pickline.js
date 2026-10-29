// ---------------------------------------------------------------------------
// Pick line tab: what's staged, shipment plans, and shipping.
// Ship is only possible from here: a shipment plan names the recipient and the ship-to
// location, lists the pick-line stock going out, and "Ship" writes one Ship transaction per line.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { openModal, confirmDialog, toast } from "./shared/ui.js";
import { $, esc, fmtDate, fmtDateTime } from "./shared/util.js";
import { S, itemName, itemCell, findLib, normSku } from "./state.js";
import { balanceCode, codeLabel, isPicklineRow, picklineLanes } from "./loc.js";
import { onHand } from "./data.js";
import { fmtNum, fmtGallons, gallonsFor, unitLabel } from "./units.js";
import { submitTransactions, summarizeResults } from "./txn.js";
import { openStage, openMove } from "./dialogs.js";
import { ownersActive, canActOn, ownerName, sameOwner } from "./owners.js";

/** Owner option for plannedQty: only compared when property owners are on. */
const ownOpt = (r) => (ownersActive() ? { owner: String(r.property_owner || "") } : {});
import {
  PLAN_STATUS, OPEN_STATUSES, linesOf, plannedQty, newShipmentId, savePlan, patchHeader, patchLines, loadShipments,
} from "./shipments.js";

const refresh = () => S.actions.refresh && S.actions.refresh();

export const picklineRows = () =>
  S.balances.filter((r) => isPicklineRow(r) && onHand(r) > 0).sort((a, b) => balanceCode(a).localeCompare(balanceCode(b)) || itemName(a).localeCompare(itemName(b)));

const statusClass = (s) => ({ Draft: "st-muted", Ready: "st-pending", Shipped: "st-ok", "Partly shipped": "st-pending", Cancelled: "st-bad" }[s] || "st-muted");

// ---------------------------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------------------------
export function initPickline() {
  const el = $("#screen-pick");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "stage") openStage();
    else if (act === "plan-new") openPlan(null);
    else if (act === "plan-open") openPlan(S.shipments.headers.find((h) => h.shipment_id === b.dataset.id));
    else if (act === "unstage") openMove({ from: b.dataset.code, sku: b.dataset.sku, lot: b.dataset.lot });
    else if (act === "plan-filter") { S.planFilter = b.dataset.f; renderPickline(); }
  });
  S.render.pick = renderPickline;
}

/** Shows the plan editor as a full page inside the Pick line tab (like the TEMAzon request form), not a dialog. */
function mountPlanPage({ title, body, buttons = [] }) {
  const host = $("#screen-pick");
  host.innerHTML = `<div class="plan-page">
    <div class="plan-bar"><button type="button" data-back>&larr; All shipment plans</button><h1>${esc(title)}</h1></div>
    <div class="modal-error plan-error" role="alert" hidden></div>
    ${body}</div>`;
  const el = host.querySelector(".plan-page");
  const foot = el.querySelector(".plan-foot");
  const err = el.querySelector(".plan-error");
  const api = {
    el,
    close() { S.planPage = null; renderPickline(); window.scrollTo(0, 0); },
    setError(msg) { err.hidden = !msg; err.textContent = msg || ""; if (msg) err.scrollIntoView({ block: "nearest" }); },
    setBusy(busy) { el.querySelectorAll(".plan-foot button").forEach((b) => (b.disabled = busy)); el.classList.toggle("busy", busy); },
  };
  S.planPage = api;
  el.querySelector("[data-back]").addEventListener("click", () => api.close());
  buttons.forEach((b) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.label === "Close" ? "Back to plans" : b.label;
    if (b.kind) btn.className = `btn-${b.kind}`;
    btn.addEventListener("click", async () => {
      api.setError("");
      try {
        api.setBusy(true);
        const result = b.action ? await b.action(api) : undefined;
        api.setBusy(false);
        if (b.close !== false && result !== false) api.close();
      } catch (e) {
        api.setBusy(false);
        api.setError(e && e.message ? e.message : String(e));
      }
    });
    foot.appendChild(btn);
  });
  window.scrollTo(0, 0);
  return api;
}

export function renderPickline() {
  if (S.planPage) return; // a plan is being edited on this tab; don't redraw over it
  const el = $("#screen-pick");
  const rows = picklineRows();
  const heads = S.shipments.headers;
  const open = heads.filter((h) => OPEN_STATUSES.includes(h.status));
  const lanes = picklineLanes();
  const totalQty = rows.reduce((n, r) => n + onHand(r), 0);
  const planned = rows.reduce((n, r) => n + plannedQty(r.item_sku, balanceCode(r), r.lot_number, ownOpt(r)), 0);
  const edit = S.canEdit;
  const filter = S.planFilter || "open";
  const shown = heads.filter((h) => (filter === "all" ? true : filter === "done" ? !OPEN_STATUSES.includes(h.status) : OPEN_STATUSES.includes(h.status)));

  const stagedRows = rows.length
    ? rows.map((r) => {
        const code = balanceCode(r);
        const pl = plannedQty(r.item_sku, code, r.lot_number, ownOpt(r));
        const avail = onHand(r) - pl;
        const lib = findLib(r.item_sku);
        const g = gallonsFor(lib, onHand(r));
        return `<tr>
          <td><span class="t">${esc(itemName(r))}</span><div class="sub">${esc(r.item_sku || "")} · ${esc(unitLabel(lib, r.unit_of_measure))}${ownersActive() && r.property_owner ? ` · <span class="owner-tag">${esc(ownerName(r.property_owner))}</span>` : ""}</div></td>
          <td class="mono">${esc(codeLabel(code))}</td>
          <td>${esc(r.lot_number || "")}</td>
          <td class="num">${fmtNum(onHand(r))}${g > 0 ? `<div class="sub">≈ ${fmtGallons(g)} gal</div>` : ""}</td>
          <td class="num">${pl ? fmtNum(pl) : "—"}</td>
          <td class="num ${avail <= 0 ? "stock-out" : ""}">${fmtNum(avail)}</td>
          <td class="row-actions">${edit && canActOn(r.property_owner) ? `<button type="button" data-act="unstage" data-code="${esc(code)}" data-sku="${esc(normSku(r.item_sku))}" data-lot="${esc(r.lot_number || "")}">Return to storage</button>` : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" class="empty">Nothing is staged on the pick line yet.${edit ? " Use “Stage to pick line”." : ""}</td></tr>`;

  const planRows = shown.length
    ? shown.map((h) => `<tr tabindex="0" data-act="plan-open" data-id="${esc(h.shipment_id)}">
        <td class="mono">${esc(h.shipment_id)}</td>
        <td><span class="t">${esc(h.ship_to_name || "")}</span><div class="sub">${esc([h.ship_to_city, h.ship_to_state].filter(Boolean).join(", "))}${h.recipient_name ? " · " + esc(h.recipient_name) : ""}</div></td>
        <td>${esc(h.order_ref || "")}</td>
        <td class="num">${fmtNum(h.line_count)} lines · ${fmtNum(h.total_qty)}</td>
        <td><span class="status-pill ${statusClass(h.status)}">${esc(h.status || "")}</span></td>
        <td>${esc(fmtDate(h.requested_date))}</td>
        <td class="sub">${esc(h.created_by || "")}</td></tr>`).join("")
    : `<tr><td colspan="7" class="empty">${S.shipments.ready ? "No shipment plans here." : "The shipments service isn't set up yet."}</td></tr>`;

  el.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="tile-n">${fmtNum(rows.length)}</div><div class="tile-l">Staged lines</div></div>
      <div class="tile"><div class="tile-n">${fmtNum(totalQty)}</div><div class="tile-l">Units on the pick line</div></div>
      <div class="tile tile-info"><div class="tile-n">${fmtNum(planned)}</div><div class="tile-l">Promised to open plans</div></div>
      <div class="tile"><div class="tile-n">${fmtNum(open.length)}</div><div class="tile-l">Open shipment plans</div></div>
    </div>
    ${S.shipments.ready ? "" : `<div class="banner banner-warn">Shipment plans need a small hosted service. ${S.isAdmin ? "Open <strong>Settings → Create the shipments service</strong>." : "Ask an Inventory Administrator to set it up (Settings)."}</div>`}
    <div class="toolbar">
      <h2>Staged on the pick line</h2><span class="sub">${lanes.length > 1 ? `${lanes.length} lanes` : "1 lane"}: ${esc(lanes.map((l) => l.label).join(", "))}</span>
      <span class="spacer"></span>
      ${edit ? `<button type="button" class="btn-primary" data-act="stage">Stage to pick line</button>` : ""}
    </div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Item</th><th>Location</th><th>Lot</th><th class="num">Staged</th><th class="num">Promised</th><th class="num">Available</th><th></th></tr></thead><tbody>${stagedRows}</tbody></table></div>

    <div class="toolbar" style="margin-top:1.4rem">
      <h2>Shipment plans</h2>
      <div class="pill-row">${[["open", "Open"], ["done", "Shipped / cancelled"], ["all", "All"]]
        .map(([k, l]) => `<button type="button" class="pill ${filter === k ? "active" : ""}" data-act="plan-filter" data-f="${k}">${l}</button>`).join("")}</div>
      <span class="spacer"></span>
      ${edit && S.shipments.ready ? `<button type="button" class="btn-primary" data-act="plan-new">New shipment plan</button>` : ""}
    </div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Plan</th><th>Ship to</th><th>Reference</th><th class="num">Contents</th><th>Status</th><th>Requested</th><th>By</th></tr></thead><tbody>${planRows}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------------------------
// Plan dialog
// ---------------------------------------------------------------------------------------------
const HEADER_FIELDS = [
  ["recipient_name", "Recipient (who receives it)", true],
  ["recipient_org", "Organization", false],
  ["recipient_phone", "Phone", false],
  ["ship_to_name", "Ship-to location name", true],
  ["ship_to_address", "Address", true],
  ["ship_to_city", "City", true],
  ["ship_to_state", "State", false],
  ["ship_to_zip", "Zip", false],
  ["ship_to_county", "County", false],
  ["order_ref", "Order / reference number", false],
];

export function validateHeader(h, lines) {
  const missing = HEADER_FIELDS.filter(([k, , req]) => req && !String(h[k] || "").trim()).map(([, l]) => l);
  const errs = [];
  if (missing.length) errs.push(`Fill in: ${missing.join(", ")}.`);
  if (!lines.length) errs.push("Add at least one item from the pick line.");
  return errs;
}

const lineKey = (sku, code, lot, owner = "") => `${normSku(sku)}|${code}|${String(lot || "").trim()}|${ownersActive() ? String(owner || "").trim().toLowerCase() : ""}`;

/** Pick-line rows with how many are still free to promise, given other plans and this editor's lines. */
export function availableRows(editorLines, { exceptShipmentId = "" } = {}) {
  const inEditor = new Map();
  for (const l of editorLines) { const k = lineKey(l.item_sku, l.from_location, l.lot, l.property_owner); inEditor.set(k, (inEditor.get(k) || 0) + (Number(l.quantity) || 0)); }
  return picklineRows()
    .filter((r) => canActOn(r.property_owner))
    .map((r) => {
      const code = balanceCode(r);
      const free = onHand(r) - plannedQty(r.item_sku, code, r.lot_number, { exceptShipmentId, ...ownOpt(r) }) - (inEditor.get(lineKey(r.item_sku, code, r.lot_number, r.property_owner)) || 0);
      return { r, code, free };
    })
    .filter((x) => x.free > 0);
}

export function openPlan(header) {
  const existing = header || null;
  const readOnly = !!existing && [PLAN_STATUS.SHIPPED, PLAN_STATUS.CANCELLED].includes(existing.status);
  const canEdit = S.canEdit && !readOnly;
  const id = existing ? existing.shipment_id : newShipmentId();
  let lines = existing ? linesOf(id).map((l) => ({ ...l })) : [];
  const val = (k) => (existing && existing[k] != null ? existing[k] : "");
  const dis = canEdit ? "" : "disabled";
  const reqDate = existing && existing.requested_date ? new Date(Number(existing.requested_date)).toISOString().slice(0, 10) : "";

  const body = `
    <div class="req-layout${canEdit ? "" : " pl-one"}">
      ${canEdit ? `<section class="catalog" aria-label="Pick line">
        <div class="catalog-tools">
          <input id="pl-find" type="search" placeholder="Search the pick line: item, make, model, barcode, lot…" autocomplete="off" aria-label="Search the pick line" />
        </div>
        <div id="pl-avail" class="catalog-list pl-avail" aria-live="polite"></div>
      </section>` : ""}
      <aside class="cart" aria-label="This shipment plan">
        <h2>Your shipment plan</h2>
        <div class="req-facts cols"><dt>Plan</dt><dd class="mono">${esc(id)}</dd><dt>Status</dt><dd><span class="status-pill ${statusClass(existing ? existing.status : "Draft")}">${esc(existing ? existing.status : "New")}</span></dd></div>
        <div id="pl-lines"></div>
        <fieldset><legend>Who and where</legend>
      <div class="two-col">${HEADER_FIELDS.map(([k, l, req]) => `<label>${esc(l)}${req ? " *" : ""}<input data-h="${k}" value="${esc(val(k) || (k === "ship_to_state" && !existing ? "TN" : ""))}" ${dis} /></label>`).join("")}
        <label>Requested ship date<input data-h="requested_date" type="date" value="${esc(reqDate)}" ${dis} /></label></div>
      <label>Notes<textarea data-h="notes" rows="2" ${dis}>${esc(val("notes"))}</textarea></label>
    </fieldset>
        <div class="plan-foot"></div>
      </aside>
    </div>`;

  const buttons = [{ label: "Close" }];
  if (existing && canEdit) buttons.push({ label: "Cancel this plan", kind: "danger", action: () => cancelPlan() });
  if (existing) buttons.push({ label: "Print pick sheet", action: () => { printSheet(collectHeader(), lines); return false; } });
  if (canEdit) {
    buttons.push({ label: "Save draft", action: () => save(PLAN_STATUS.DRAFT) });
    buttons.push({ label: "Mark ready", action: () => save(PLAN_STATUS.READY) });
    buttons.push({ label: "Ship now", kind: "primary", action: () => shipNow() });
  }
  const m = mountPlanPage({ title: readOnly ? `Shipment ${id}` : existing ? `Shipment plan ${id}` : "New shipment plan", body, buttons });
  const root = m.el;
  const q = (s) => root.querySelector(s);

  const collectHeader = () => {
    const h = { shipment_id: id, status: existing ? existing.status : PLAN_STATUS.DRAFT };
    root.querySelectorAll("[data-h]").forEach((i) => {
      const k = i.dataset.h;
      if (k === "requested_date") h[k] = i.value ? new Date(i.value + "T12:00:00").getTime() : null;
      else h[k] = i.value.trim();
    });
    return h;
  };

  // Pick-line stock this plan may draw on (other plans' promises already taken off), as cards.
  const catRows = () => picklineRows().filter((r) => canActOn(r.property_owner)).map((r) => {
    const code = balanceCode(r);
    const base = onHand(r) - plannedQty(r.item_sku, code, r.lot_number, { exceptShipmentId: id, ...ownOpt(r) });
    return { r, code, base, k: lineKey(r.item_sku, code, r.lot_number, r.property_owner) };
  }).filter((x) => x.base > 0);
  const openLine = (k) => lines.find((l) => l.status !== "Shipped" && lineKey(l.item_sku, l.from_location, l.lot, l.property_owner) === k);
  let shown = [];

  const setLineQty = (x, qty) => {
    qty = Math.max(0, Math.floor(Number(qty) || 0));
    if (qty > x.base) { toast(`Only ${fmtNum(x.base)} free of that line.`, "error"); qty = x.base; }
    const ln = openLine(x.k);
    if (qty <= 0) { if (ln) lines.splice(lines.indexOf(ln), 1); }
    else if (ln) ln.quantity = qty;
    else lines.push({ item_sku: normSku(x.r.item_sku), item_desc: itemName(x.r), unit: unitLabel(findLib(x.r.item_sku), x.r.unit_of_measure), quantity: qty, lot: x.r.lot_number || "", from_location: x.code, property_owner: ownersActive() ? String(x.r.property_owner || "") : "", status: "Planned" });
    renderLines(); renderAvail();
  };

  const stepper = (qty, attr, max) => `<div class="stepper" role="group" aria-label="Quantity">
      <button type="button" data-dec ${attr} aria-label="Decrease quantity">−</button>
      <input type="number" min="1" ${max ? `max="${max}"` : ""} step="1" inputmode="numeric" value="${qty}" data-qty ${attr} aria-label="Quantity" />
      <button type="button" data-inc ${attr} aria-label="Increase quantity">+</button></div>`;

  const cardHtml = (x, i) => {
    const ln = openLine(x.k);
    const own = ownersActive() && x.r.property_owner ? ` · <span class="owner-tag">${esc(ownerName(x.r.property_owner))}</span>` : "";
    const unit = unitLabel(findLib(x.r.item_sku), x.r.unit_of_measure);
    return `<article class="item-card${ln ? " in-cart" : ""}" data-ck="${i}">
      <div class="item-main">${ln ? `<span class="in-cart-badge" title="In this plan">✓ In plan</span>` : ""}${itemCell(x.r, findLib(x.r.item_sku))}
        <div class="item-meta"><span class="mono">${esc(codeLabel(x.code))}</span>${x.r.lot_number ? " · lot " + esc(x.r.lot_number) : ""}${own}</div>
        <div class="item-stock stock-ok">${fmtNum(x.base)} ${esc(unit)} free</div></div>
      <div class="item-actions">${ln ? stepper(ln.quantity, `data-ck="${i}"`, x.base) : `<button type="button" class="btn-add" data-add data-ck="${i}">Add</button>`}</div>
    </article>`;
  };

  function renderAvail() {
    const host = q("#pl-avail");
    if (!host) return;
    const term = (q("#pl-find").value || "").trim().toLowerCase();
    shown = catRows().filter((x) => {
      if (!term) return true;
      const lib = findLib(x.r.item_sku);
      return `${itemName(x.r)} ${x.r.item_sku || ""} ${x.r.make || ""} ${x.r.model || ""} ${x.r.lot_number || ""} ${codeLabel(x.code)} ${ownerName(x.r.property_owner)} ${lib ? Object.values(lib).join(" ") : ""}`.toLowerCase().includes(term);
    });
    host.innerHTML = shown.length ? shown.map(cardHtml).join("")
      : `<div class="empty">${term ? "Nothing on the pick line matches that." : "Nothing free on the pick line. Stage stock to it first."}</div>`;
  }

  function renderLines() {
    const host = q("#pl-lines");
    host.innerHTML = lines.length
      ? lines.map((l, i) => {
          const edit = canEdit && l.status !== "Shipped";
          return `<div class="cart-line" data-li="${i}">
            <div class="cart-line-main"><div class="cart-line-title">${esc(l.item_desc || l.item_sku)}</div>
              <div class="cart-line-sub">${esc(l.item_sku || "")} · <span class="mono">${esc(codeLabel(l.from_location))}</span>${l.lot ? " · lot " + esc(l.lot) : ""}${l.property_owner ? ` · <span class="owner-tag">${esc(ownerName(l.property_owner))}</span>` : ""}${l.status && l.status !== "Planned" ? ` · ${esc(l.status)}` : ""}${l.note ? `<div>${esc(l.note)}</div>` : ""}</div></div>
            ${edit ? stepper(l.quantity, `data-li="${i}"`) : `<div class="num">${fmtNum(l.quantity)}${l.unit ? ` <span class="sub">${esc(l.unit)}</span>` : ""}</div>`}
            ${edit ? `<button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove line">&times;</button>` : "<span></span>"}</div>`;
        }).join("") + `<div class="cart-summary">${lines.length} line${lines.length === 1 ? "" : "s"} · ${fmtNum(lines.reduce((n, l) => n + Number(l.quantity || 0), 0))} units</div>`
      : `<div class="empty">${canEdit ? "Nothing added yet. Use <b>Add</b> on any pick-line item." : "No items."}</div>`;
  }
  renderLines();
  if (canEdit) {
    renderAvail();
    q("#pl-find").addEventListener("input", renderAvail);
    // Catalog cards (left): Add / − / + / typed quantity
    q("#pl-avail").addEventListener("click", (e) => {
      const el = e.target.closest("[data-add],[data-inc],[data-dec]");
      if (!el) return;
      const x = shown[Number(el.dataset.ck)];
      if (!x) return;
      const cur = openLine(x.k);
      setLineQty(x, el.matches("[data-add]") ? 1 : (cur ? Number(cur.quantity) : 0) + (el.matches("[data-inc]") ? 1 : -1));
    });
    q("#pl-avail").addEventListener("change", (e) => {
      if (!e.target.matches("[data-qty]")) return;
      const x = shown[Number(e.target.dataset.ck)];
      if (x) setLineQty(x, e.target.value);
    });
    // Plan lines (right): − / + / typed quantity / remove
    const lineQty = (i, qty) => {
      const l = lines[i];
      if (!l) return;
      qty = Math.max(0, Math.floor(Number(qty) || 0));
      const x = catRows().find((c) => c.k === lineKey(l.item_sku, l.from_location, l.lot, l.property_owner));
      if (x && qty > x.base) { toast(`Only ${fmtNum(x.base)} free of that line.`, "error"); qty = x.base; }
      if (qty <= 0) lines.splice(i, 1); else l.quantity = qty;
      renderLines(); renderAvail();
    };
    q("#pl-lines").addEventListener("click", (e) => {
      const el = e.target.closest("[data-inc],[data-dec],[data-rm]");
      if (!el) return;
      if (el.matches("[data-rm]")) return lineQty(Number(el.dataset.rm), 0);
      const i = Number(el.dataset.li);
      lineQty(i, Number(lines[i] && lines[i].quantity) + (el.matches("[data-inc]") ? 1 : -1));
    });
    q("#pl-lines").addEventListener("change", (e) => {
      if (e.target.matches("[data-qty]")) lineQty(Number(e.target.dataset.li), e.target.value);
    });
  }

  async function save(status) {
    const h = collectHeader();
    if (status === PLAN_STATUS.READY) {
      const errs = validateHeader(h, lines);
      if (errs.length) throw new Error(errs.join(" "));
    } else if (!lines.length && !h.ship_to_name && !h.recipient_name) {
      throw new Error("Enter at least who or where it's going, or add an item.");
    }
    h.status = status;
    await savePlan(h, lines, { existing });
    toast(status === PLAN_STATUS.READY ? "Plan marked ready." : "Draft saved.", "success");
    refresh();
  }

  async function cancelPlan() {
    const ok = await confirmDialog({ title: "Cancel this plan?", message: "Nothing has shipped. The items stay on the pick line.", confirmLabel: "Cancel plan", kind: "danger" });
    if (!ok) return false;
    await patchHeader(existing, { status: PLAN_STATUS.CANCELLED });
    toast("Plan cancelled.", "success");
    refresh();
  }

  async function shipNow() {
    const h = collectHeader();
    const errs = validateHeader(h, lines);
    if (errs.length) throw new Error(errs.join(" "));
    const pending = lines.filter((l) => l.status !== "Shipped");
    const total = pending.reduce((n, l) => n + Number(l.quantity) - (Number(l.qty_shipped) || 0), 0);
    const ok = await confirmDialog({
      title: "Ship now?",
      message: `Ship ${fmtNum(total)} item(s) in ${pending.length} line(s) to ${h.ship_to_name}? This takes them out of inventory.`,
      confirmLabel: "Ship",
    });
    if (!ok) return false;
    h.status = PLAN_STATUS.READY;
    await savePlan(h, lines, { existing });
    const saved = S.shipments.headers.find((x) => x.shipment_id === id);
    await shipPlan(saved);
    refresh();
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Shipping a saved plan
// ---------------------------------------------------------------------------------------------
export async function shipPlan(header) {
  const id = header.shipment_id;
  const planLines = linesOf(id).filter((l) => l.status !== "Shipped");
  const shipTo = [header.ship_to_name, header.ship_to_address, header.ship_to_city, header.ship_to_state].filter(Boolean).join(", ").slice(0, 250);
  const txnLines = planLines.map((l) => ({
    type: "Ship", sku: l.item_sku, name: l.item_desc, qty: Number(l.quantity) - (Number(l.qty_shipped) || 0), lot: l.lot || "",
    from: l.from_location, owner: l.property_owner || "", extra: { shipment_id: id, ship_to: shipTo },
  }));
  const results = await submitTransactions(txnLines);
  const patches = [];
  results.forEach((r, i) => {
    const line = planLines[i];
    if (r.ok) patches.push({ line, patch: { status: "Shipped", qty_shipped: Number(line.quantity), transaction_gid: r.gid || "", note: r.status === "pending" ? "Saved; waiting to apply to inventory" : "" } });
    else patches.push({ line, patch: { status: "Failed", note: String(r.message || "").slice(0, 250) } });
  });
  await patchLines(patches);
  const allShipped = results.length === planLines.length && results.every((r) => r.ok);
  const anyShipped = results.some((r) => r.ok);
  await patchHeader(header, allShipped
    ? { status: PLAN_STATUS.SHIPPED, shipped_by: S.me.name, shipped_date: Date.now() }
    : { status: anyShipped ? PLAN_STATUS.PARTLY : PLAN_STATUS.READY });
  const s = summarizeResults(results, planLines.length);
  toast(allShipped ? `Shipment ${id} shipped.` : s.text, allShipped ? s.kind : "error", 9000);
  await loadShipments();
  return results;
}

// ---------------------------------------------------------------------------------------------
// Pick sheet (print)
// ---------------------------------------------------------------------------------------------
export function pickSheetHtml(h, lines) {
  const rows = lines.map((l) => `<tr><td>${esc(l.item_desc || "")}<br><small>${esc(l.item_sku || "")}</small></td><td>${esc(codeLabel(l.from_location))}</td><td>${esc(l.lot || "")}</td><td style="text-align:right">${fmtNum(l.quantity)}</td><td style="width:70px"></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pick sheet ${esc(h.shipment_id)}</title>
<style>body{font:14px Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin-top:14px}th,td{border:1px solid #888;padding:6px 8px;text-align:left}th{background:#eee}.meta td{border:0;padding:2px 12px 2px 0}</style></head><body>
<h1>Pick sheet — ${esc(h.shipment_id)}</h1>
<table class="meta"><tr><td><b>Ship to</b></td><td>${esc(h.ship_to_name || "")}<br>${esc([h.ship_to_address, h.ship_to_city, h.ship_to_state, h.ship_to_zip].filter(Boolean).join(", "))}</td>
<td><b>Recipient</b></td><td>${esc(h.recipient_name || "")}${h.recipient_org ? "<br>" + esc(h.recipient_org) : ""}${h.recipient_phone ? "<br>" + esc(h.recipient_phone) : ""}</td></tr>
<tr><td><b>Reference</b></td><td>${esc(h.order_ref || "")}</td><td><b>Requested</b></td><td>${esc(fmtDate(h.requested_date))}</td></tr></table>
<table><thead><tr><th>Item</th><th>Pick from</th><th>Lot</th><th>Qty</th><th>Picked</th></tr></thead><tbody>${rows}</tbody></table>
<p>${esc(h.notes || "")}</p><p><small>Printed ${esc(fmtDateTime(Date.now()))} by ${esc(S.me.name)}</small></p></body></html>`;
}

function printSheet(h, lines) {
  const w = window.open("", "_blank", "width=800,height=900");
  if (!w) return toast("Allow pop-ups to print the pick sheet.", "error");
  w.document.write(pickSheetHtml(h, lines));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
