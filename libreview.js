// ---------------------------------------------------------------------------
// Barcode Library review (Settings): reads the live library and lists suggested corrections
// to the unit / volume fields, the same way the one-off "volume cleanup" sheet was produced:
//   count_unit, units_per_pack, unit_volume, unit_volume_uom  (+ gallons_per_count_unit, derived)
// Suggestions are parsed from make / model / description and the old volume + Volume_type.
//   High    parsed text agrees with the old volume
//   Medium  parsed from text or derived: check it
//   Review  nothing reliable found: fill in by hand
// Nothing is written until an administrator ticks rows and presses Apply (edit the proposed
// values first if they are wrong). Existing values are never overwritten, only blanks are filled.
// Also lists read-only problems: possible duplicate barcodes and missing basics.
// ---------------------------------------------------------------------------
import { $, esc, debounce, toCSV, downloadText } from "./shared/util.js";
import { applyEdits } from "./shared/esri-client.js";
import { toast, confirmDialog } from "./shared/ui.js";
import { S } from "./state.js";
import { ci, gallonsPerVolume } from "./units.js";
import { loadLibrary } from "./data.js";
import { COUNT_UNITS, PACK_UNITS, VOLUME_UOMS, VOLUME_ITEMS } from "./lists.js";

const str = (v) => String(v ?? "").trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const close = (a, b) => a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) < 0.03;

const UOM_MAP = [[/^(fl\.?\s*)?(oz|ounces?)$/i, "oz"], [/^gal(lons?)?$/i, "gal"], [/^(qt|quarts?)$/i, "qt"], [/^(l|lit(er|re)s?)$/i, "L"], [/^(ml|milliliters?)$/i, "mL"]];
/** "Fl Oz" / "Gal" / "liter" ... -> oz | gal | qt | L | mL ("" when unknown). */
export function normUom(v) {
  const t = str(v);
  for (const [re, out] of UOM_MAP) if (re.test(t)) return out;
  return "";
}
const gal = (v, uom) => gallonsPerVolume(v, uom);
const unitCase = (v) => COUNT_UNITS.find((u) => u.toLowerCase() === str(v).toLowerCase()) || "";

/** Pack count and bottle size mentioned in free text. Pure. */
export function parseText(text) {
  const t = String(text || "");
  const out = { pack: null, size: null, notes: [] };
  const packRes = [
    /case of\s*(\d+)/i,
    /(\d+)\s*[-\s]?\(?\s*(?:ct|count|pk|pack)\b\)?/i,
    /(\d+)\b[A-Za-z\s]{0,20}?\b(?:per|in a|\/)\s*case/i,
    /(\d+)\s*\/\s*case/i,
    /(\d+)\s*-\s*case/i,
  ];
  for (const re of packRes) {
    const m = t.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (n > 100) { out.notes.push(`Ignored an unusually large pack count (${n})`); continue; }
    if (n < 2) continue;
    const unit = /\bcase/i.test(t) ? "Case" : /\b(pack|pk)\b/i.test(t) ? "Pack" : /\bbox/i.test(t) ? "Box" : /\b(ct|count)\b/i.test(t) ? "Case" : "Case";
    out.pack = { n, unit };
    break;
  }
  const sz = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?|\d+\s*-\s*\d+)\s*(fl\.?\s*oz|oz|ounces?|gal(?:lons?)?|quarts?|qt|liters?|litres?|ml|l)\b/i.exec(t);
  if (sz) {
    const raw = sz[1].replace(/\s+/g, "");
    let v;
    if (raw.includes("-")) v = Math.max(...raw.split("-").map(Number));
    else if (raw.includes("/")) { const [a, b] = raw.split("/").map(Number); v = b ? a / b : 0; }
    else v = Number(raw);
    const uom = normUom(sz[2]);
    if (v > 0 && uom) out.size = { v: round(v, 3), uom };
  } else {
    const w = /\b(gallon|quart)\b/i.exec(t);
    if (w) out.size = { v: 1, uom: /gallon/i.test(w[1]) ? "gal" : "qt" };
  }
  return out;
}

/**
 * Suggested unit / volume values for one library row, or null when the row is complete.
 * { oid, current, proposed, confidence, notes[], issues[] }
 */
export function suggest(row) {
  const item = str(ci(row, "item"));
  const volRel = VOLUME_ITEMS.includes(item);
  const cur = {
    count_unit: unitCase(ci(row, "count_unit")) || str(ci(row, "count_unit")),
    units_per_pack: num(ci(row, "units_per_pack")) || null,
    unit_volume: num(ci(row, "unit_volume")) || null,
    unit_volume_uom: normUom(ci(row, "unit_volume_uom")) || str(ci(row, "unit_volume_uom")),
    gallons_per_count_unit: num(ci(row, "gallons_per_count_unit")) || null,
  };
  const issues = [];
  if (!cur.count_unit) issues.push("No count unit");
  if (PACK_UNITS.includes(cur.count_unit) && !cur.units_per_pack) issues.push("No items per pack");
  if (volRel && !(cur.unit_volume && cur.unit_volume_uom)) issues.push("No volume");

  const p = parseText([ci(row, "make"), ci(row, "model"), ci(row, "description")].map(str).join(" "));
  const text = [ci(row, "make"), ci(row, "model"), ci(row, "description")].map(str).join(" ");
  const V = num(ci(row, "volume")), VU = normUom(ci(row, "Volume_type"));
  const gV = V > 0 && VU ? gal(V, VU) : 0;
  const notes = [...p.notes];

  // counted unit
  let unit = cur.count_unit;
  let n = cur.units_per_pack;
  if (!unit) { if (p.pack) { unit = p.pack.unit; n = n || p.pack.n; } else unit = "Each"; }
  const isPack = PACK_UNITS.includes(unit);
  if (isPack && !n && p.pack) n = p.pack.n;
  if (!isPack) n = null;

  // volume of ONE item
  let size = cur.unit_volume && cur.unit_volume_uom ? { v: cur.unit_volume, uom: cur.unit_volume_uom } : null;
  let high = false;
  if (!size && volRel) {
    if (p.size) {
      size = p.size;
      const g1 = gal(size.v, size.uom);
      if (gV) {
        if (isPack && n && close(gV, g1 * n)) { notes.push("Current volume was the whole case (= bottle size x pack count)"); high = true; }
        else if (close(gV, g1)) notes.push(isPack ? "Current volume was ONE item; case total is now computed" : "Current volume agrees");
        else notes.push("Parsed from text; disagrees with current volume -- check");
      } else notes.push("Parsed from text; no current volume to compare");
    } else if (gV) {
      if (isPack && n && gV * 128 > 70 * 1.0) {
        size = { v: round(V / n, 2), uom: VU };
        notes.push("Bottle size was DERIVED from current volume / pack count (not stated in text) -- verify");
      } else size = { v: V, uom: VU };
    }
  }
  if (volRel && !size) notes.push(p.pack ? "Pack count found but no bottle size -- fill in" : "Could not read a volume -- fill in manually");
  if (!isPack && !str(ci(row, "count_unit"))) notes.push("No pack count found -- confirm the counted unit");
  if (!isPack && /\b(case|pack|pallet|box)\b/i.test(text)) notes.push("Text mentions case/pack/pallet; check");

  const proposed = {
    count_unit: volRel && !size && !p.pack && !cur.count_unit ? "" : unit,
    units_per_pack: isPack ? n || null : null,
    unit_volume: size ? size.v : null,
    unit_volume_uom: size ? size.uom : "",
  };
  // fill blanks only: never overwrite what is already set
  for (const k of Object.keys(proposed)) if (k !== "units_per_pack" && cur[k]) proposed[k] = cur[k];
  if (cur.units_per_pack) proposed.units_per_pack = cur.units_per_pack;
  proposed.gallons_per_count_unit = proposed.unit_volume && proposed.unit_volume_uom ? round(gal(proposed.unit_volume, proposed.unit_volume_uom) * (PACK_UNITS.includes(proposed.count_unit) ? proposed.units_per_pack || 1 : 1), 3) : null;

  if (!issues.length && proposed.gallons_per_count_unit && !close(proposed.gallons_per_count_unit, cur.gallons_per_count_unit || 0)) issues.push("Gallons per unit out of date");
  if (!issues.length) return null;

  const confidence = volRel && !size ? "Review" : (high && isPack) || (issues.length === 1 && issues[0] === "Gallons per unit out of date") ? "High" : "Medium";
  return { oid: row._oid, row, current: cur, proposed, confidence, notes: [...new Set(notes)], issues };
}

/** Read-only problems: possible duplicate barcodes and records missing the basics. */
export function otherIssues(rows) {
  const live = rows.filter((r) => str(ci(r, "delete_flag")).toLowerCase() !== "yes");
  const groups = new Map();
  for (const r of live) {
    const k = str(ci(r, "barcode")).replace(/^0+/, "").toLowerCase();
    if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const dups = [...groups.values()].filter((g) => g.length > 1);
  const missing = live.filter((r) => !str(ci(r, "item_category")) || !str(ci(r, "item")) || !str(ci(r, "make")));
  return { dups, missing };
}

export const reviewAll = () => S.library.filter((r) => str(ci(r, "delete_flag")).toLowerCase() !== "yes").map(suggest).filter(Boolean);

// ---- UI -------------------------------------------------------------------------------------
const UI = { filter: "", q: "", page: 1, picked: new Set(), edits: new Map(), seeded: false };
const PAGE = 60;
const libCaps = () => str(S.info.lib && S.info.lib.raw && S.info.lib.raw.capabilities).toLowerCase();
const canUpdate = () => libCaps().includes("update") || libCaps().includes("editing");
const effective = (s) => ({ ...s.proposed, ...(UI.edits.get(s.oid) || {}) });
const galOf = (e) => (num(e.unit_volume) > 0 && e.unit_volume_uom ? round(gal(num(e.unit_volume), e.unit_volume_uom) * (PACK_UNITS.includes(e.count_unit) ? Math.round(num(e.units_per_pack)) || 1 : 1), 3) : null);
const tagClass = { High: "tag-ok", Medium: "", Review: "tag-restricted" };

let list = [];

function rowHtml(s) {
  const e = effective(s);
  const r = s.row;
  const oldVol = num(ci(r, "volume")) ? `${num(ci(r, "volume"))} ${str(ci(r, "Volume_type"))}` : "";
  const dis = !canUpdate() ? "disabled" : "";
  const g = galOf(e);
  return `<tr data-oid="${esc(s.oid)}">
    <td><input type="checkbox" data-lr="pick" ${UI.picked.has(s.oid) ? "checked" : ""} ${dis} aria-label="Apply to ${esc(str(ci(r, "item")))}" /></td>
    <td><span class="t">${esc([ci(r, "make"), ci(r, "model")].map(str).filter(Boolean).join(" ") || str(ci(r, "item")))}</span>
      <div class="sub">${esc(str(ci(r, "item")))} · <span class="mono">${esc(str(ci(r, "barcode")))}</span></div>
      ${str(ci(r, "description")) ? `<div class="sub">${esc(str(ci(r, "description")))}</div>` : ""}</td>
    <td class="sub">${esc(s.issues.join(", "))}${oldVol ? `<div>old volume ${esc(oldVol)}</div>` : ""}${s.current.count_unit ? `<div>${esc(s.current.count_unit)}${s.current.units_per_pack ? " of " + s.current.units_per_pack : ""}</div>` : ""}</td>
    <td class="lr-edit"><select data-lr="count_unit" aria-label="Count unit"><option value=""></option>${COUNT_UNITS.map((u) => `<option ${e.count_unit === u ? "selected" : ""}>${u}</option>`).join("")}</select>
      <input data-lr="units_per_pack" type="number" min="1" step="1" placeholder="per pack" value="${esc(e.units_per_pack ?? "")}" ${PACK_UNITS.includes(e.count_unit) ? "" : "disabled"} aria-label="Items per pack" />
      <input data-lr="unit_volume" type="number" min="0" step="any" placeholder="volume of one" value="${esc(e.unit_volume ?? "")}" aria-label="Volume of one item" />
      <select data-lr="unit_volume_uom" aria-label="Volume unit"><option value=""></option>${VOLUME_UOMS.map((u) => `<option value="${u.value}" ${e.unit_volume_uom === u.value ? "selected" : ""}>${u.value}</option>`).join("")}</select></td>
    <td class="num" id="lr-gal-${esc(s.oid)}">${g ? g : ""}</td>
    <td><span class="tag ${tagClass[s.confidence]}">${s.confidence}</span>${s.notes.length ? `<div class="sub">${esc(s.notes.join("; "))}</div>` : ""}</td></tr>`;
}

function paint() {
  const host = $("#lr-host");
  if (!host) return;
  if (!S.library.length) { host.innerHTML = `<div class="card"><h2>Barcode Library review</h2><p class="sub">The Barcode Library hasn't loaded yet.</p></div>`; return; }
  list = reviewAll();
  if (!UI.seeded) { list.forEach((s) => { if (s.confidence === "High") UI.picked.add(s.oid); }); UI.seeded = true; }
  const oids = new Set(list.map((s) => s.oid));
  for (const o of [...UI.picked]) if (!oids.has(o)) UI.picked.delete(o);
  const by = (c) => list.filter((s) => s.confidence === c).length;
  const q = UI.q.toLowerCase();
  const shown = list.filter((s) => (!UI.filter || s.confidence === UI.filter) && (!q || `${ci(s.row, "item")} ${ci(s.row, "make")} ${ci(s.row, "model")} ${ci(s.row, "barcode")} ${ci(s.row, "description")}`.toLowerCase().includes(q)));
  const { dups, missing } = otherIssues(S.library);
  const upd = canUpdate();
  host.innerHTML = `<div class="card"><h2>Barcode Library review</h2>
    <p class="sub">Reads the live Barcode Library and suggests the unit and volume details each item is missing (parsed from make, model, description and the old volume). Nothing is saved until you tick rows and press <strong>Apply</strong>. Edit a proposed value first if it is wrong; only blank fields are filled, and existing values are never overwritten. The gallons per unit is worked out from your values.</p>
    ${list.length ? `<p><strong>${list.length}</strong> item${list.length === 1 ? "" : "s"} to review: <span class="tag tag-ok">${by("High")} High</span> <span class="tag">${by("Medium")} Medium</span> <span class="tag tag-restricted">${by("Review")} Review</span>
      <span class="hint">High = text agrees with the old volume · Medium = check it · Review = fill in by hand</span></p>` : `<p class="stock-ok">✓ Every library item has its unit and volume details.</p>`}
    ${upd ? "" : `<p class="banner banner-warn">Your account can't edit the Barcode Library, so suggestions can be viewed and downloaded but not applied.</p>`}
    ${list.length ? `<div class="toolbar">
      <input id="lr-q" type="search" placeholder="Item, make, barcode" value="${esc(UI.q)}" aria-label="Search suggestions" />
      <select id="lr-filter" aria-label="Confidence"><option value="">All</option>${["High", "Medium", "Review"].map((c) => `<option ${UI.filter === c ? "selected" : ""}>${c}</option>`).join("")}</select>
      <button type="button" data-lr="sel-high" ${upd ? "" : "disabled"}>Tick all High</button>
      <button type="button" data-lr="sel-none">Untick all</button>
      <span class="spacer"></span>
      <button type="button" data-lr="csv">Download CSV</button>
      <button type="button" data-lr="rescan">Re-scan</button>
      <button type="button" class="btn-primary" data-lr="apply" ${upd && UI.picked.size ? "" : "disabled"}>Apply selected (${UI.picked.size})</button></div>
    <div class="table-wrap tall"><table class="grid lr-grid"><thead><tr><th></th><th>Item</th><th>Problem / current</th><th>Proposed</th><th class="num">Gal / unit</th><th>Confidence</th></tr></thead><tbody id="lr-body">${
      shown.slice(0, UI.page * PAGE).map(rowHtml).join("") || `<tr><td colspan="6" class="empty">Nothing matches.</td></tr>`}</tbody></table></div>
    <div class="sub" style="margin:.4rem 0">${shown.length} shown${shown.length > UI.page * PAGE ? ` · <button type="button" class="link-btn" data-lr="more">Show more</button>` : ""}</div>` : ""}
    ${dups.length || missing.length ? `<details class="lr-other"><summary>Other problems to fix by hand (${dups.length} possible duplicate barcode${dups.length === 1 ? "" : "s"}, ${missing.length} missing basics)</summary>
      ${dups.length ? `<h3>Possible duplicate barcodes</h3><p class="hint">Same barcode (ignoring leading zeros) on more than one record. Keep one and use Flag for delete on the Library tab for the others. Stock and history keep working.</p>
        <ul class="lr-dups">${dups.map((g) => `<li><span class="mono">${esc(str(ci(g[0], "barcode")))}</span>: ${g.map((r) => `${esc([ci(r, "make"), ci(r, "model"), ci(r, "item")].map(str).filter(Boolean).join(" "))} <span class="sub">(#${esc(r._oid)}${str(ci(r, "barcode")) !== str(ci(g[0], "barcode")) ? ", " + esc(str(ci(r, "barcode"))) : ""})</span>`).join(" · ")}</li>`).join("")}</ul>` : ""}
      ${missing.length ? `<h3>Missing category, item or make</h3><ul class="lr-dups">${missing.slice(0, 50).map((r) => `<li><span class="mono">${esc(str(ci(r, "barcode")))}</span> ${esc([ci(r, "make"), ci(r, "model"), ci(r, "item")].map(str).filter(Boolean).join(" ") || "(blank)")} <span class="sub">missing ${[!str(ci(r, "item_category")) && "category", !str(ci(r, "item")) && "item", !str(ci(r, "make")) && "make"].filter(Boolean).join(", ")}</span></li>`).join("")}${missing.length > 50 ? `<li class="sub">…and ${missing.length - 50} more</li>` : ""}</ul>` : ""}
    </details>` : ""}</div>`;
}

function fitLib(attrs) {
  const names = new Map(((S.info.lib && S.info.lib.fields) || []).map((f) => [f.name.toLowerCase(), f.name]));
  const out = {};
  for (const [k, v] of Object.entries(attrs)) { const real = names.get(k.toLowerCase()); if (real && v !== undefined) out[real] = v; }
  return out;
}

async function apply(btn) {
  const chosen = list.filter((s) => UI.picked.has(s.oid));
  const problems = [];
  const updates = [];
  const key = (S.info.lib && S.info.lib.objectIdField) || "OBJECTID";
  for (const s of chosen) {
    const e = effective(s);
    const name = [ci(s.row, "make"), ci(s.row, "model"), ci(s.row, "item")].map(str).filter(Boolean).join(" ");
    if (e.count_unit && !COUNT_UNITS.includes(e.count_unit)) problems.push(`${name}: unknown count unit`);
    if (PACK_UNITS.includes(e.count_unit) && !(num(e.units_per_pack) >= 1)) problems.push(`${name}: ${e.count_unit} needs the items per pack`);
    if ((num(e.unit_volume) > 0) !== !!e.unit_volume_uom) problems.push(`${name}: volume and its unit go together`);
    const pack = PACK_UNITS.includes(e.count_unit) ? Math.round(num(e.units_per_pack)) || null : null;
    const hasVol = num(e.unit_volume) > 0 && e.unit_volume_uom;
    updates.push({ attributes: fitLib({
      [key]: s.oid,
      count_unit: e.count_unit || null, units_per_pack: pack,
      unit_volume: hasVol ? num(e.unit_volume) : null, unit_volume_uom: hasVol ? e.unit_volume_uom : null,
      gallons_per_count_unit: hasVol ? galOf({ ...e, units_per_pack: pack }) : null,
    }) });
  }
  if (problems.length) return toast(`Fix first: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`, "error", 9000);
  if (!updates.length) return;
  const ok = await confirmDialog({ title: `Update ${updates.length} library item${updates.length === 1 ? "" : "s"}?`, message: "This writes the proposed unit and volume values to the Barcode Library. Items you didn't tick are not touched.", confirmLabel: "Apply" });
  if (!ok) return;
  btn.disabled = true;
  try {
    for (let i = 0; i < updates.length; i += 100) await applyEdits(S.urls.lib, { updates: updates.slice(i, i + 100) });
    await loadLibrary();
    UI.edits.clear(); UI.picked.clear();
    toast(`Updated ${updates.length} item${updates.length === 1 ? "" : "s"}.`, "success");
  } catch (err) { toast(`Couldn't update the library: ${err.message}`, "error", 10000); }
  paint();
}

function exportCsv() {
  const cols = [
    { label: "objectid", get: (s) => s.oid }, { label: "barcode", get: (s) => str(ci(s.row, "barcode")) }, { label: "item", get: (s) => str(ci(s.row, "item")) },
    { label: "make", get: (s) => str(ci(s.row, "make")) }, { label: "model", get: (s) => str(ci(s.row, "model")) }, { label: "description", get: (s) => str(ci(s.row, "description")) },
    { label: "current volume", get: (s) => ci(s.row, "volume") ?? "" }, { label: "current Volume_type", get: (s) => str(ci(s.row, "Volume_type")) },
    { label: "count_unit", get: (s) => effective(s).count_unit }, { label: "units_per_pack", get: (s) => effective(s).units_per_pack ?? "" },
    { label: "unit_volume", get: (s) => effective(s).unit_volume ?? "" }, { label: "unit_volume_uom", get: (s) => effective(s).unit_volume_uom },
    { label: "gallons_per_count_unit", get: (s) => galOf(effective(s)) ?? "" }, { label: "confidence", get: (s) => s.confidence },
    { label: "notes", get: (s) => [...s.issues, ...s.notes].join("; ") },
  ];
  downloadText(`barcode_library_review_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(list, cols));
}

export function mountLibReview() {
  const host = $("#lr-host");
  if (!host) return;
  if (!host._wired) {
    host._wired = true;
    host.addEventListener("input", debounce((e) => { if (e.target.id === "lr-q") { UI.q = e.target.value; UI.page = 1; paint(); $("#lr-q") && ($("#lr-q").focus(), $("#lr-q").setSelectionRange(UI.q.length, UI.q.length)); } }, 250));
    host.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "lr-filter") { UI.filter = t.value; UI.page = 1; return paint(); }
      const tr = t.closest("tr[data-oid]");
      if (!tr) return;
      const s = list.find((x) => String(x.oid) === tr.dataset.oid);
      if (!s) return;
      const f = t.dataset.lr;
      if (f === "pick") { t.checked ? UI.picked.add(s.oid) : UI.picked.delete(s.oid); const b = host.querySelector('[data-lr="apply"]'); if (b) { b.textContent = `Apply selected (${UI.picked.size})`; b.disabled = !canUpdate() || !UI.picked.size; } return; }
      if (!["count_unit", "units_per_pack", "unit_volume", "unit_volume_uom"].includes(f)) return;
      const ed = { ...(UI.edits.get(s.oid) || {}) };
      ed[f] = f === "units_per_pack" || f === "unit_volume" ? (t.value === "" ? null : Number(t.value)) : t.value;
      UI.edits.set(s.oid, ed);
      const e2 = effective(s);
      if (f === "count_unit") { const pk = tr.querySelector('[data-lr="units_per_pack"]'); pk.disabled = !PACK_UNITS.includes(e2.count_unit); if (pk.disabled) { ed.units_per_pack = null; pk.value = ""; } }
      const g = galOf(e2); const cell = tr.querySelector(`#lr-gal-${CSS.escape(String(s.oid))}`); if (cell) cell.textContent = g ? g : "";
      if (!UI.picked.has(s.oid)) { UI.picked.add(s.oid); const cb = tr.querySelector('[data-lr="pick"]'); if (cb && !cb.disabled) cb.checked = true; const b = host.querySelector('[data-lr="apply"]'); if (b) { b.textContent = `Apply selected (${UI.picked.size})`; b.disabled = !canUpdate(); } }
    });
    host.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-lr]");
      if (!b) return;
      const a = b.dataset.lr;
      if (a === "sel-high") { list.filter((s) => s.confidence === "High").forEach((s) => UI.picked.add(s.oid)); paint(); }
      else if (a === "sel-none") { UI.picked.clear(); paint(); }
      else if (a === "more") { UI.page += 1; paint(); }
      else if (a === "csv") exportCsv();
      else if (a === "rescan") {
        b.disabled = true;
        try { await loadLibrary(); UI.seeded = false; UI.picked.clear(); UI.edits.clear(); } catch (err) { toast(err.message, "error"); }
        paint();
      } else if (a === "apply") await apply(b);
    });
  }
  paint();
}
