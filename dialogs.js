// ---------------------------------------------------------------------------
// The three everyday dialogs: Receive, Move, Stage to pick line.
// (Ship happens from a shipment plan — see pickline.js.)
// Each one builds transaction lines and hands them to submitTransactions().
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";
import { openModal, toast } from "./shared/ui.js";
import { esc } from "./shared/util.js";
import { S, itemName, findLib, normSku } from "./state.js";
import { balancesAtCode, balancesForSku, onHand } from "./data.js";
import { balanceCode, codeLabel, parseCode, picklineLanes, isPicklineRow, isPicklineCode } from "./loc.js";
import { submitTransactions, summarizeResults } from "./txn.js";
import { itemPicker, scanInput, wireScan } from "./widgets.js";
import { fmtNum, fmtGallons, gallonsFor, unitLabel, ci } from "./units.js";
import { ownersActive, canActOn, canLeaveUnowned, receiveChoices, ownerName } from "./owners.js";

let lastOwner = ""; // remembered between "receive another" dialogs

const done = () => S.actions.refresh && S.actions.refresh();

async function run(lines) {
  const results = await submitTransactions(lines);
  const s = summarizeResults(results, lines.length);
  toast(s.text, s.kind, s.kind === "error" ? 9000 : 4500);
  done();
  if (results.some((r) => !r.ok)) throw new Error(s.text); // keeps the dialog open with the message
  return results;
}

/** Live "Z1-AA-01-01-P1" confirmation under a location box. */
function bindLocationHint(root, id, { requirePicklineHint = false } = {}) {
  const input = root.querySelector("#" + id);
  const hint = root.querySelector("#" + id + "-hint");
  const upd = () => {
    const raw = input.value.trim();
    if (!raw) { hint.textContent = ""; return; }
    const p = parseCode(raw);
    if (!p) { hint.textContent = "Location codes are 8 or 10 characters (e.g. Z1AA0101P1)."; hint.className = "form-error"; return; }
    hint.className = "hint";
    hint.textContent = `→ ${codeLabel(raw)}${isPicklineCode(raw) ? " (pick line)" : ""}`;
  };
  input.addEventListener("input", upd);
  input.addEventListener("change", upd);
  upd();
}
const locBox = (id, label, value = "") =>
  `${scanInput({ id, label, placeholder: "Scan or type the location", value })}<div class="hint" id="${id}-hint"></div>`;

// ---------------------------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------------------------
export function openReceive({ again = false, sku = "" } = {}) {
  let picked = null;
  const body = `
    <div id="rc-item"></div>
    <div id="rc-details" hidden>
      <div class="two-col">
        <label>Quantity <input id="rc-qty" type="number" min="1" step="1" inputmode="numeric" data-qty /></label>
        <label>Counted as <input id="rc-unit" readonly /></label>
      </div>
      <div class="hint" id="rc-gal"></div>
      <label>Lot / reference code (optional) <input id="rc-lot" /></label>
    </div>
    ${locBox("rc-to", "Put-away location")}
    ${ownersActive() ? `<label>Property owner (the group that manages this stock)${canLeaveUnowned() ? "" : " *"}
      <select id="rc-owner">${canLeaveUnowned() ? `<option value="">— No owner (shared warehouse stock) —</option>` : receiveChoices().length > 1 ? `<option value="">Choose…</option>` : ""}${receiveChoices().map((o) => `<option value="${esc(o.code)}" ${o.code === lastOwner ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>` : ""}`;
  let another = false;
  const m = openModal({
    title: "Receive stock",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Save and receive another", action: async (mm) => { await save(mm); another = true; } },
      { label: "Save receipt", kind: "primary", action: (mm) => save(mm) },
    ],
    onClose: () => { if (another) setTimeout(() => openReceive({ again: true }), 0); },
  });
  const root = m.el;
  const $ = (id) => root.querySelector("#" + id);
  wireScan(root);
  bindLocationHint(root, "rc-to");
  const picker = itemPicker($("rc-item"), {
    mode: "library",
    onPick: (p) => {
      picked = p;
      $("rc-details").hidden = !p;
      if (!p) return;
      $("rc-unit").value = unitLabel(p.lib) || "(no unit set in the library)";
      refreshGal();
      $("rc-qty").focus();
    },
  });
  const refreshGal = () => {
    if (!picked) return;
    const g = gallonsFor(picked.lib, Number($("rc-qty").value) || 0);
    $("rc-gal").textContent = g > 0 ? `≈ ${fmtGallons(g)} gallons` : "";
  };
  root.addEventListener("input", (e) => { if (e.target.id === "rc-qty") refreshGal(); });
  if (sku) {
    const l = findLib(sku);
    const hit = S.balances.find((r) => normSku(r.item_sku) === normSku(sku));
    if (l || hit) picker.set({ sku: normSku(sku), lib: l, name: hit ? itemName(hit) : l ? String(ci(l, "item") ?? sku) : sku });
    else picker.focus();
  } else picker.focus();

  async function save() {
    if (!picked) throw new Error("Scan or choose the item first.");
    const qty = Number($("rc-qty").value);
    const to = parseCode($("rc-to").value);
    if (!to) throw new Error("Scan or type a valid put-away location.");
    const owner = ownersActive() ? $("rc-owner").value : "";
    if (ownersActive() && !owner && !canLeaveUnowned()) throw new Error("Choose the property owner.");
    await run([{ type: "Receive", sku: picked.sku, name: picked.name, qty, lot: $("rc-lot").value.trim(), to: to.code, owner }]);
    lastOwner = owner;
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------------------------
/** Opens Move. `from` (code) and `sku` pre-fill when launched from a stock row. */
export function openMove({ from = "", sku = "", lot = undefined } = {}) {
  const body = `
    ${locBox("mv-from", "From location", from)}
    <div id="mv-contents" class="mv-contents"></div>
    ${locBox("mv-to", "To location")}`;
  const m = openModal({
    title: "Move stock",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Move", kind: "primary", action: () => save() },
    ],
  });
  const root = m.el;
  const $ = (id) => root.querySelector("#" + id);
  wireScan(root);
  bindLocationHint(root, "mv-from");
  bindLocationHint(root, "mv-to");
  let rows = [];

  const renderContents = () => {
    const p = parseCode($("mv-from").value);
    const host = $("mv-contents");
    if (!p) { host.innerHTML = ""; rows = []; return; }
    rows = balancesAtCode(p.code);
    if (!rows.length) { host.innerHTML = `<div class="banner banner-warn">Nothing is recorded at ${esc(codeLabel(p.code))}.</div>`; return; }
    host.innerHTML = `<table class="mini-table"><thead><tr><th></th><th>Item</th><th class="num">On hand</th><th class="num">Move</th></tr></thead><tbody>${rows
      .map((r, i) => {
        const can = canActOn(r.property_owner);
        const pre = can && (sku ? normSku(r.item_sku) === normSku(sku) && (lot === undefined || String(r.lot_number || "") === String(lot || "")) : rows.length === 1);
        const lib = findLib(r.item_sku);
        const own = ownersActive() ? ` · ${r.property_owner ? "owner " + esc(ownerName(r.property_owner)) : "no owner"}${can ? "" : " (not yours to move)"}` : "";
        return `<tr><td><input type="checkbox" data-i="${i}" ${pre ? "checked" : ""} ${can ? "" : "disabled"} aria-label="Move ${esc(itemName(r))}" /></td>
          <td>${esc(itemName(r))}<div class="sub">${esc(r.item_sku || "")}${r.lot_number ? " · lot " + esc(r.lot_number) : ""} · ${esc(unitLabel(lib, r.unit_of_measure))}${own}</div></td>
          <td class="num">${fmtNum(onHand(r))}</td>
          <td class="num"><input class="count-input" type="number" min="1" max="${onHand(r)}" step="1" data-q="${i}" value="${onHand(r)}" inputmode="numeric" data-qty ${can ? "" : "disabled"} /></td></tr>`;
      })
      .join("")}</tbody></table>`;
  };
  $("mv-from").addEventListener("change", renderContents);
  renderContents();

  async function save() {
    const from = parseCode($("mv-from").value);
    const to = parseCode($("mv-to").value);
    if (!from) throw new Error("Enter the From location.");
    if (!to) throw new Error("Enter the To location.");
    const lines = [];
    root.querySelectorAll("#mv-contents [data-i]").forEach((cb) => {
      if (!cb.checked) return;
      const i = Number(cb.dataset.i);
      const r = rows[i];
      const qty = Number(root.querySelector(`[data-q="${i}"]`).value);
      lines.push({ type: "Move", sku: normSku(r.item_sku), name: itemName(r), qty, lot: r.lot_number || "", from: from.code, to: to.code, owner: r.property_owner || "" });
    });
    if (!lines.length) throw new Error("Tick at least one item to move.");
    await run(lines);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Stage to pick line
// ---------------------------------------------------------------------------------------------

/** Spreads `total` across rows (already in the order to draw from). Returns quantities per row. */
export function distribute(rows, total) {
  let left = Math.max(0, Math.floor(Number(total) || 0));
  return rows.map((r) => {
    const take = Math.min(left, onHand(r));
    left -= take;
    return take;
  });
}

/** Rows to draw from, oldest first (by last_update; rows never updated sort first), pick line excluded. */
export function sourceRows(sku) {
  return balancesForSku(sku)
    .filter((r) => !isPicklineRow(r) && canActOn(r.property_owner))
    .sort((a, b) => (Number(a.last_update) || 0) - (Number(b.last_update) || 0) || balanceCode(a).localeCompare(balanceCode(b)));
}

export function openStage({ sku = "" } = {}) {
  const lanes = picklineLanes();
  const body = `
    <div id="st-item"></div>
    <div id="st-detail" hidden>
      <div class="st-top">
        <label>Total to stage <input id="st-total" type="number" min="1" step="1" inputmode="numeric" data-qty style="width:7rem" /></label>
        <button type="button" id="st-fill">Fill from oldest stock</button>
      </div>
      <div id="st-rows"></div>
      <div class="rv-totals" id="st-sum"></div>
    </div>
    <label ${lanes.length > 1 ? "" : "hidden"}>Pick-line lane
      <select id="st-lane">${lanes.map((l) => `<option value="${l.code}">Lane ${l.lane} · ${esc(l.label)}</option>`).join("")}</select>
    </label>
    <div class="hint">Stages to <strong id="st-dest">${esc(lanes[0].label)}</strong> (pick line).</div>`;
  const m = openModal({
    title: "Stage to pick line",
    body,
    buttons: [{ label: "Cancel" }, { label: "Stage", kind: "primary", action: () => save() }],
  });
  const root = m.el;
  const $ = (id) => root.querySelector("#" + id);
  let picked = null;
  let rows = [];
  const lib = () => (picked ? picked.lib || findLib(picked.sku) : null);

  const recalc = () => {
    let tot = 0;
    root.querySelectorAll("[data-q]").forEach((i) => { tot += Number(i.value) || 0; });
    const g = gallonsFor(lib(), tot);
    $("st-sum").textContent = `Staging ${fmtNum(tot)}${g > 0 ? ` · ≈ ${fmtGallons(g)} gal` : ""}`;
    root.querySelectorAll("[data-i]").forEach((cb) => {
      const q = root.querySelector(`[data-q="${cb.dataset.i}"]`);
      cb.checked = (Number(q.value) || 0) > 0;
    });
  };
  const fill = () => {
    const take = distribute(rows, $("st-total").value);
    rows.forEach((_, i) => { root.querySelector(`[data-q="${i}"]`).value = take[i] || 0; });
    recalc();
  };
  const renderRows = () => {
    rows = sourceRows(picked.sku);
    if (!rows.length) { $("st-rows").innerHTML = `<div class="banner banner-warn">No stock of this item outside the pick line.</div>`; $("st-detail").hidden = false; return; }
    $("st-detail").hidden = false;
    $("st-rows").innerHTML = `<table class="mini-table"><thead><tr><th></th><th>Location</th><th>Lot</th>${ownersActive() ? "<th>Owner</th>" : ""}<th class="num">On hand</th><th class="num">Stage</th></tr></thead><tbody>${rows
      .map((r, i) => `<tr><td><input type="checkbox" data-i="${i}" disabled aria-label="Selected" /></td><td class="mono">${esc(codeLabel(balanceCode(r)))}</td><td>${esc(r.lot_number || "")}</td>${ownersActive() ? `<td class="sub">${esc(ownerName(r.property_owner) || "—")}</td>` : ""}
        <td class="num">${fmtNum(onHand(r))}</td>
        <td class="num"><input class="count-input" type="number" min="0" max="${onHand(r)}" step="1" data-q="${i}" value="0" inputmode="numeric" data-qty /></td></tr>`)
      .join("")}</tbody></table>`;
    recalc();
  };
  const picker = itemPicker($("st-item"), { mode: "stock", onPick: (p) => { picked = p; if (p) renderRows(); else $("st-detail").hidden = true; } });
  root.addEventListener("input", (e) => { if (e.target.matches("[data-q]")) recalc(); });
  $("st-fill").addEventListener("click", fill);
  const lane = root.querySelector("#st-lane");
  lane.addEventListener("change", () => { $("st-dest").textContent = codeLabel(lane.value); });
  if (sku) {
    const l = findLib(sku);
    const hit = S.balances.find((r) => normSku(r.item_sku) === normSku(sku));
    picker.set({ sku: normSku(sku), lib: l, name: hit ? itemName(hit) : l ? String(ci(l, "item") ?? sku) : sku });
  } else picker.focus();

  async function save() {
    if (!picked) throw new Error("Choose the item to stage.");
    const dest = lane.value || lanes[0].code;
    const lines = [];
    rows.forEach((r, i) => {
      const qty = Number(root.querySelector(`[data-q="${i}"]`).value) || 0;
      if (qty > 0) lines.push({ type: "Move", sku: normSku(r.item_sku), name: itemName(r), qty, lot: r.lot_number || "", from: balanceCode(r), to: dest, owner: r.property_owner || "" });
    });
    if (!lines.length) throw new Error("Enter how many to stage, or use “Fill from oldest stock”.");
    await run(lines);
  }
  return m;
}
