// ---------------------------------------------------------------------------
// Map tab: every warehouse bay as a pin on aerial imagery, coloured by how full it is.
// Anyone can look; Administrators place, move, edit and remove pins. Leaflet (loaded the first time the
// tab opens) draws the map; the pins live in the "Locations" layer of the shipments service (locations.js).
// ---------------------------------------------------------------------------
import { $, esc } from "./shared/util.js";
import { toast, confirmDialog } from "./shared/ui.js";
import { getToken } from "./shared/arcgis-auth.js";
import { S, itemName } from "./state.js";
import { codeLabel } from "./loc.js";
import { fmtNum } from "./units.js";
import { addLocationsLayer } from "./shipments.js";
import {
  LOCATION_TYPES, bayLabel, parseBayInput, locationsReady, canEditLocations, loadLocations, stockByBay, unplacedBays,
  addLocation, moveLocation, updateLocation, deleteLocation,
} from "./locations.js";

const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4";
const VIEW_KEY = "linc_map_view";

const M = { map: null, L: null, pins: new Map(), sel: null, mode: "view", draft: null, adjust: false, editing: false, fitted: false, loading: false, tileFail: 0, q: "" };

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = `${LEAFLET}/leaflet.css`;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = `${LEAFLET}/leaflet.js`;
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error("The map library couldn't be loaded (check the network)."));
    document.head.appendChild(js);
  });
}

// ---- pins ----------------------------------------------------------------------------------------
function pinClass(loc, qty) {
  if (!loc.active) return "off";
  if (!qty) return "empty";
  if (loc.capacity > 0) { const f = qty / loc.capacity; return f >= 0.9 ? "full" : f >= 0.5 ? "mid" : "low"; }
  return "has";
}

function paintPins() {
  if (!M.map) return;
  const L = M.L;
  const stock = stockByBay();
  const seen = new Set();
  for (const loc of S.locations) {
    if (loc.lat === null) continue;
    seen.add(loc.bay);
    const qty = (stock.get(loc.bay) || { qty: 0 }).qty;
    const icon = L.divIcon({ className: "", html: `<div class="map-pin pin-${pinClass(loc, qty)}${M.sel === loc.bay ? " sel" : ""}"><span>${qty ? fmtNum(qty) : ""}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
    let m = M.pins.get(loc.bay);
    if (!m) {
      m = L.marker([loc.lat, loc.lng], { icon, draggable: false, title: `${bayLabel(loc.bay)}${loc.label && loc.label !== bayLabel(loc.bay) ? " · " + loc.label : ""}` }).addTo(M.map);
      m.on("click", () => { if (M.mode === "view") { M.sel = loc.bay; M.editing = false; paintPins(); paintSide(); } });
      m.on("dragend", async () => {
        const p = m.getLatLng();
        try { await moveLocation(loc.oid, p.lng, p.lat); toast(`${bayLabel(loc.bay)} moved.`, "success", 2000); } catch (err) { toast(err.message, "error"); await loadLocations(); }
        paintPins();
      });
      M.pins.set(loc.bay, m);
    } else { m.setIcon(icon); m.setLatLng([loc.lat, loc.lng]); }
    if (M.adjust && canEditLocations()) m.dragging.enable(); else m.dragging.disable();
  }
  for (const [bay, m] of M.pins) if (!seen.has(bay)) { m.remove(); M.pins.delete(bay); }
}

// ---- side panel ----------------------------------------------------------------------------------
const typeOptions = (cur) => LOCATION_TYPES.map((t) => `<option ${cur === t ? "selected" : ""}>${t}</option>`).join("");

function overviewHtml() {
  const stock = stockByBay();
  const placed = S.locations.filter((l) => l.lat !== null);
  const withStock = placed.filter((l) => (stock.get(l.bay) || { qty: 0 }).qty > 0).length;
  const un = unplacedBays();
  const edit = canEditLocations();
  const q = M.q.trim().toLowerCase();
  const hits = q ? placed.filter((l) => `${l.bay} ${bayLabel(l.bay)} ${l.label}`.toLowerCase().includes(q)).slice(0, 8) : [];
  return `
    <div class="map-search"><input id="map-q" type="search" placeholder="Find a bay (Z1-AA-01)" value="${esc(M.q)}" aria-label="Find a bay" /></div>
    ${hits.length ? `<div class="map-hits">${hits.map((l) => `<button type="button" data-act="goto" data-bay="${esc(l.bay)}"><b>${esc(bayLabel(l.bay))}</b> <span class="sub">${esc(l.label && l.label !== bayLabel(l.bay) ? l.label : l.type)}</span></button>`).join("")}</div>` : q ? `<div class="sub">No bay matches.</div>` : ""}
    <div class="map-stats"><div><b>${fmtNum(placed.length)}</b><span class="sub">on the map</span></div><div><b>${fmtNum(withStock)}</b><span class="sub">hold stock</span></div><div><b>${fmtNum(un.length)}</b><span class="sub ${un.length ? "warn" : ""}">need placing</span></div></div>
    <div class="map-legend"><span><i class="map-pin pin-empty mini"></i>Empty</span><span><i class="map-pin pin-low mini"></i>&lt; 50%</span><span><i class="map-pin pin-mid mini"></i>50–90%</span><span><i class="map-pin pin-full mini"></i>≥ 90%</span><span><i class="map-pin pin-has mini"></i>No capacity set</span></div>
    ${edit ? `<div class="map-actions"><button type="button" class="btn-primary" data-act="add">Add a location</button><button type="button" class="${M.adjust ? "btn-primary" : ""}" data-act="adjust" aria-pressed="${M.adjust}">${M.adjust ? "Done adjusting" : "Adjust positions"}</button></div>${M.adjust ? `<div class="sub">Drag any pin to where it really is. It saves when you let go.</div>` : ""}` : ""}
    ${un.length ? `<h3>Stock with no pin yet</h3><ul class="map-list">${un.slice(0, 40).map((u) => `<li><span><b>${esc(bayLabel(u.bay))}</b> <span class="sub">${fmtNum(u.qty)} units</span></span>${edit ? `<button type="button" data-act="place" data-bay="${esc(u.bay)}">Place</button>` : ""}</li>`).join("")}${un.length > 40 ? `<li class="sub">…and ${un.length - 40} more</li>` : ""}</ul>` : ""}
    ${!placed.length ? `<p class="sub">${edit ? "Nothing is on the map yet. Choose Add a location, enter the bay code, then click where it is on the map." : "Nothing is on the map yet. An administrator can add the bays."}</p>` : ""}`;
}

function detailHtml(loc) {
  const stock = (stockByBay().get(loc.bay) || { qty: 0, lines: [] });
  const edit = canEditLocations();
  const lines = stock.lines.sort((a, b) => b.qty - a.qty);
  if (M.editing && edit) {
    return `<button type="button" class="link-btn" data-act="back">&larr; Back</button>
      <h3>Edit ${esc(bayLabel(loc.bay))}</h3>
      <label>Label<input id="ed-label" value="${esc(loc.label)}" /></label>
      <div class="two-col"><label>Type<select id="ed-type">${typeOptions(loc.type)}</select></label><label>Capacity (units)<input id="ed-cap" type="number" min="0" step="1" value="${esc(loc.capacity ?? "")}" /></label></div>
      <label class="check"><input id="ed-active" type="checkbox" ${loc.active ? "checked" : ""} /> Active</label>
      <label>Notes<input id="ed-notes" value="${esc(loc.notes)}" /></label>
      <div class="map-actions"><button type="button" class="btn-primary" data-act="save-edit">Save</button><button type="button" data-act="cancel-edit">Cancel</button></div>`;
  }
  const pct = loc.capacity > 0 ? Math.round((stock.qty / loc.capacity) * 100) : null;
  return `<button type="button" class="link-btn" data-act="back">&larr; All bays</button>
    <h3>${esc(bayLabel(loc.bay))} ${loc.active ? "" : `<span class="tag tag-muted">Inactive</span>`}</h3>
    <div class="sub">${esc([loc.label && loc.label !== bayLabel(loc.bay) ? loc.label : "", loc.type].filter(Boolean).join(" · "))}${loc.notes ? `<div>${esc(loc.notes)}</div>` : ""}</div>
    <div class="map-stats"><div><b>${fmtNum(stock.qty)}</b><span class="sub">units here</span></div><div><b>${loc.capacity ? fmtNum(loc.capacity) : "—"}</b><span class="sub">capacity</span></div><div><b>${pct === null ? "—" : pct + "%"}</b><span class="sub">full</span></div></div>
    <div class="map-actions"><button type="button" class="btn-primary" data-act="stock" data-bay="${esc(loc.bay)}">Open in Stock</button>${edit ? `<button type="button" data-act="edit">Edit</button><button type="button" data-act="delete">Remove pin</button>` : ""}</div>
    ${lines.length ? `<table class="mini-table"><thead><tr><th>Item</th><th>Where</th><th class="num">Qty</th></tr></thead><tbody>${lines.map((l) => `<tr><td>${esc(itemName(l.r))}<div class="sub">${esc(l.r.item_sku || "")}</div></td><td class="mono">${esc(codeLabel(l.code))}</td><td class="num">${fmtNum(l.qty)}</td></tr>`).join("")}</tbody></table>` : `<p class="sub">Nothing stored here.</p>`}`;
}

function placeHtml() {
  const d = M.draft;
  return `<button type="button" class="link-btn" data-act="cancel-place">&larr; Cancel</button>
    <h3>Add a location</h3>
    <label>Bay code *<input id="pl-bay" value="${esc(d.bay)}" placeholder="Z1-AA-01" /></label>
    <label>Label (optional)<input id="pl-label" value="${esc(d.label)}" placeholder="Reserve rack, east wall" /></label>
    <div class="two-col"><label>Type<select id="pl-type">${typeOptions(d.type)}</select></label><label>Capacity (units)<input id="pl-cap" type="number" min="0" step="1" value="${esc(d.capacity)}" /></label></div>
    <label>Notes<input id="pl-notes" value="${esc(d.notes)}" /></label>
    <div class="banner banner-info" id="pl-hint">Fill this in, then <b>click the spot on the map</b>. Zoom in first for a precise spot.</div>`;
}

function paintSide() {
  const side = $("#map-side");
  if (!side) return;
  const loc = M.sel ? S.locations.find((l) => l.bay === M.sel) : null;
  if (M.mode === "place" && M.draft) side.innerHTML = placeHtml();
  else if (loc) side.innerHTML = detailHtml(loc);
  else { M.sel = null; side.innerHTML = overviewHtml(); }
}

// ---- the tab -------------------------------------------------------------------------------------
function setupCard(msg = "") {
  const edit = S.isAdmin && S.canEdit;
  return `<div class="card"><h2>Map locations</h2>
    <p class="sub">Place each warehouse bay on a map so people can see where stock is. The pins are stored in a <strong>Locations</strong> layer in the shipments service, which doesn't exist yet.</p>
    ${msg ? `<p class="banner banner-warn">${esc(msg)}</p>` : ""}
    ${!S.shipments.ready ? `<p class="banner banner-warn">The shipments service isn't set up yet. Create it in Settings first.</p>`
      : edit ? `<button type="button" class="btn-primary" data-act="make-layer">Create the Locations layer</button><p class="sub">Needs an account that can edit the shipments service's definition (the one that created it).</p>`
      : `<p class="sub">Ask an administrator to create it.</p>`}</div>`;
}

export function initMap() {
  const el = $("#screen-map");
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    try {
      if (a === "retry-map") return renderMap();
      if (a === "make-layer") {
        b.disabled = true;
        await addLocationsLayer();
        toast("Locations layer created.", "success");
        return renderMap();
      }
      if (a === "goto") { M.sel = b.dataset.bay; const l = S.locations.find((x) => x.bay === M.sel); if (l && M.map) M.map.setView([l.lat, l.lng], Math.max(M.map.getZoom(), 19)); paintPins(); return paintSide(); }
      if (a === "back") { M.sel = null; M.editing = false; paintPins(); return paintSide(); }
      if (a === "stock") return S.actions.showStock && S.actions.showStock(b.dataset.bay);
      if (a === "adjust") { M.adjust = !M.adjust; paintPins(); return paintSide(); }
      if (a === "add" || a === "place") {
        M.mode = "place"; M.sel = null;
        M.draft = { bay: a === "place" ? bayLabel(b.dataset.bay) : "", label: "", type: "Reserve", capacity: "", notes: "" };
        $("#map-el").classList.add("placing");
        return paintSide();
      }
      if (a === "cancel-place") return endPlace();
      if (a === "edit") { M.editing = true; return paintSide(); }
      if (a === "cancel-edit") { M.editing = false; return paintSide(); }
      if (a === "save-edit") {
        const loc = S.locations.find((l) => l.bay === M.sel);
        await updateLocation(loc.oid, { label: $("#ed-label").value, type: $("#ed-type").value, capacity: $("#ed-cap").value, active: $("#ed-active").checked, notes: $("#ed-notes").value });
        M.editing = false; toast("Saved.", "success", 1800); paintPins(); return paintSide();
      }
      if (a === "delete") {
        const loc = S.locations.find((l) => l.bay === M.sel);
        const ok = await confirmDialog({ title: `Remove ${bayLabel(loc.bay)} from the map?`, message: "This only removes the pin. Stock recorded at this bay is not touched, and you can place it again later.", confirmLabel: "Remove pin", kind: "danger" });
        if (!ok) return;
        await deleteLocation(loc.oid);
        M.sel = null; toast("Pin removed.", "success", 1800); paintPins(); return paintSide();
      }
    } catch (err) { toast(err.message, "error", 8000); b.disabled = false; }
  });
  el.addEventListener("input", (e) => {
    if (e.target.id === "map-q") { M.q = e.target.value; const pos = M.q.length; paintSide(); const i = $("#map-q"); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
    else if (M.draft && ["pl-bay", "pl-label", "pl-type", "pl-cap", "pl-notes"].includes(e.target.id)) M.draft = { bay: $("#pl-bay").value, label: $("#pl-label").value, type: $("#pl-type").value, capacity: $("#pl-cap").value, notes: $("#pl-notes").value };
  });
  S.render.map = renderMap;
}

function endPlace() {
  M.mode = "view"; M.draft = null;
  const m = $("#map-el"); if (m) m.classList.remove("placing");
  paintSide();
}

async function onMapClick(ev) {
  if (M.mode !== "place" || !M.draft) return;
  const d = { bay: $("#pl-bay").value, label: $("#pl-label").value, type: $("#pl-type").value, capacity: $("#pl-cap").value, notes: $("#pl-notes").value };
  M.draft = d;
  const key = parseBayInput(d.bay);
  const hint = $("#pl-hint");
  if (!key) { if (hint) { hint.className = "banner banner-warn"; hint.textContent = "Enter the bay code first (like Z1-AA-01), then click the map."; } return; }
  try {
    await addLocation({ bay: key, label: d.label, type: d.type, capacity: d.capacity, notes: d.notes, lng: ev.latlng.lng, lat: ev.latlng.lat });
    toast(`${bayLabel(key)} placed.`, "success", 2000);
    M.sel = key;
    endPlace(); paintPins(); paintSide();
  } catch (err) { if (hint) { hint.className = "banner banner-warn"; hint.textContent = err.message; } }
}

export async function renderMap() {
  const el = $("#screen-map");
  if (!el) return;
  if (!locationsReady()) { M.map = null; M.pins.clear(); el.innerHTML = setupCard(); return; }
  if (!el.querySelector("#map-el")) {
    M.map = null; M.pins.clear();
    el.innerHTML = `<div class="map-wrap"><div id="map-el" class="map-el"><div class="sub" style="padding:1rem">Loading the map…</div></div><aside id="map-side" class="map-side"></aside></div>`;
  }
  if (M.loading) return;
  M.loading = true;
  try {
    const [L] = await Promise.all([loadLeaflet(), loadLocations()]);
    M.L = L;
    if (!M.map) {
      const host = $("#map-el");
      host.innerHTML = "";
      let view = null;
      try { view = JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); } catch { /* none saved */ }
      M.map = L.map(host, { zoomControl: true, maxZoom: 22 }).setView(view ? [view.lat, view.lng] : [36.16, -86.78], view ? view.z : 7);
      const imagery = L.tileLayer(`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(getToken() || "")}`, { maxNativeZoom: 19, maxZoom: 22, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" });
      const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxNativeZoom: 19, maxZoom: 22, attribution: "&copy; OpenStreetMap contributors" });
      imagery.on("tileerror", () => { if (++M.tileFail === 6) toast("The aerial imagery isn't loading. Switch to Streets with the layers button on the map.", "info", 9000); });
      imagery.addTo(M.map);
      L.control.layers({ "Aerial imagery": imagery, "Streets": streets }, {}, { position: "topright" }).addTo(M.map);
      M.map.on("click", onMapClick);
      M.map.on("moveend", () => { const c = M.map.getCenter(); try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, z: M.map.getZoom() })); } catch { /* storage unavailable */ } });
      M.fitted = !!view;
    }
    M.map.invalidateSize();
    paintPins();
    const placed = S.locations.filter((l) => l.lat !== null);
    if (!M.fitted && placed.length) { M.map.fitBounds(M.L.latLngBounds(placed.map((l) => [l.lat, l.lng])).pad(0.2), { maxZoom: 20 }); M.fitted = true; }
    const side = $("#map-side");
    if (side && !(side.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName))) paintSide();
  } catch (err) {
    el.innerHTML = `<div class="card"><h2>Map locations</h2><p class="banner banner-warn">Couldn't load the map: ${esc(err.message)}</p><button type="button" data-act="retry-map">Try again</button></div>`;
    M.map = null; M.pins.clear();
  } finally { M.loading = false; }
}
