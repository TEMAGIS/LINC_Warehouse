// ---------------------------------------------------------------------------
// "Add to Barcode Library" — shown whenever a scanned barcode isn't in the library, so the
// item is there next time. Same questions as the Barcode Library survey (category, item,
// make, model, size, volume / pack info, photo), written straight to the library layer.
// ---------------------------------------------------------------------------
import { applyEdits, addAttachment } from "./shared/esri-client.js";
import { openModal, toast } from "./shared/ui.js";
import { esc } from "./shared/util.js";
import { S, findLib, indexLibrary } from "./state.js";
import { scanOnce } from "./scanner.js";
import { gallonsPerVolume, ci } from "./units.js";
import { loadLibrary } from "./data.js";
import {
  LIB_CATEGORIES, LIB_ITEMS, COUNT_UNITS, PACK_UNITS, VOLUME_UOMS, VOLUME_ITEMS, SIZE_ITEMS, SIZES,
} from "./lists.js";

const LEGACY_VOLUME_TYPE = { oz: "Oz", mL: "mL", L: "L", qt: "Qt", gal: "Gal" };
const COLOR_ITEMS = ["Shirt", "Hat", "Pants", "Jacket", "Shoes", "Vest"];

const options = (list, { blank = "" } = {}) =>
  (blank !== null ? `<option value="">${esc(blank)}</option>` : "") + list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");

const hasField = (name) => !!(S.info.lib && S.info.lib.fields.some((f) => f.name.toLowerCase() === name.toLowerCase()));

/** Gray "UPLOAD IMAGE" card, drawn in the browser, used when no photo is taken. */
export function makePlaceholderFile() {
  const c = document.createElement("canvas");
  c.width = 640; c.height = 480;
  const g = c.getContext("2d");
  g.fillStyle = "#e5e7eb"; g.fillRect(0, 0, 640, 480);
  g.strokeStyle = "#6b7280"; g.lineWidth = 6; g.strokeRect(10, 10, 620, 460);
  g.fillStyle = "#1f2937"; g.textAlign = "center";
  g.font = "bold 54px sans-serif"; g.fillText("UPLOAD IMAGE", 320, 250);
  g.font = "30px sans-serif"; g.fillStyle = "#374151";
  g.fillText("No photo yet for this item", 320, 320);
  g.fillText("Add one, then delete this", 320, 365);
  return new Promise((resolve) => c.toBlob((b) => resolve(new File([b], "PLACEHOLDER_upload_image.png", { type: "image/png" })), "image/png"));
}

export function openAddToLibrary({ barcode = "", onSaved = null } = {}) {
  if (!S.canEdit) { toast("Your account can't add to the Barcode Library.", "error"); return null; }
  const newFields = hasField("count_unit");
  const body = `
    ${newFields ? "" : `<div class="banner banner-warn">The Barcode Library layer doesn't have the unit fields yet (republish the updated survey). The item will still be added, without pack / unit details.</div>`}
    <label>Barcode
      <span class="scan-row"><input id="lb-barcode" value="${esc(barcode)}" autocomplete="off" /><button type="button" data-scan="lb-barcode" aria-label="Scan with camera">Scan</button></span>
    </label>
    <label>This barcode is on
      <select id="lb-btype"><option value="Item">The item's own packaging</option><option value="Container">A container (case, box, pallet)</option></select>
    </label>
    <label id="lb-ibc-wrap" hidden>Barcode of one item inside
      <span class="scan-row"><input id="lb-item-barcode" autocomplete="off" /><button type="button" data-scan="lb-item-barcode" aria-label="Scan with camera">Scan</button></span>
      <span class="hint">The library is keyed on the item's barcode; the container barcode is saved alongside it.</span>
    </label>
    <div class="two-col">
      <label>Item category <select id="lb-cat">${options(LIB_CATEGORIES, { blank: "Choose…" })}</select></label>
      <label>Item <select id="lb-item">${options(LIB_ITEMS, { blank: "Choose…" })}</select></label>
    </div>
    <label id="lb-other-wrap" hidden>Specify other item <input id="lb-other" /></label>
    <div class="two-col">
      <label>Make <input id="lb-make" /></label>
      <label>Model <input id="lb-model" /></label>
    </div>
    <label>Description <input id="lb-desc" placeholder="e.g. 16.9 oz bottled water" /></label>

    <div data-items="${esc(SIZE_ITEMS.join("|"))}" hidden>
      <div class="two-col"><label>Size <select id="lb-size">${options(SIZES, { blank: "Choose…" })}</select></label>
      <label data-items="${esc(COLOR_ITEMS.join("|"))}" hidden>Color <input id="lb-color" /></label></div>
    </div>
    <div data-items="Gloves" hidden>
      <div class="two-col">
        <label>Medical or non-medical <select id="lb-med"><option value=""></option><option>Medical</option><option>Non-Medical</option></select></label>
        <label>Glove type <select id="lb-gtype">${options(["Latex", "Nitrile", "Vinyl", "Other"])}</select></label>
      </div>
      <label>Glove thickness <select id="lb-gthick">${options(["Unknown", "Not Applicable", ...Array.from({ length: 12 }, (_, i) => `${i + 1} Mil`)])}</select></label>
    </div>
    <div data-items="Mask" hidden><label>Mask type <select id="lb-mask">${options(["Cloth", "KN-95", "Surgical Mask", "N-95 Respirators", "Surgical N95", "N99", "N100", "R95", "P99", "P100", "Half-mask Respirators", "Full-face Respirators", "Respirator Cartridges", "Window Mask", "Other"])}</select></label></div>
    <div data-items="Disinfectant Wipes" hidden><label>Wipe count per container <input id="lb-wipes" type="number" min="0" /></label></div>

    <fieldset><legend>Counting</legend>
      <div class="two-col">
        <label>What is one counted unit? <select id="lb-cu">${options(COUNT_UNITS, { blank: null })}</select></label>
        <label id="lb-pack-wrap" hidden>Items in each pack / case / box <input id="lb-pack" type="number" min="1" step="1" /></label>
      </div>
      <div data-items="${esc(VOLUME_ITEMS.join("|"))}" hidden>
        <div class="two-col">
          <label>Volume of ONE item <input id="lb-uv" type="number" min="0" step="any" /></label>
          <label>Unit <select id="lb-uvu"><option value="">Choose…</option>${VOLUME_UOMS.map((u) => `<option value="${esc(u.value)}">${esc(u.label)}</option>`).join("")}</select></label>
        </div>
        <div class="hint" id="lb-gal"></div>
      </div>
      <label>Counted units per pallet (optional) <input id="lb-pallet" type="number" min="0" /></label>
    </fieldset>

    <label>Photo of the item
      <input id="lb-photo" type="file" accept="image/*" capture="environment" />
    </label>
    <label class="check"><input id="lb-nophoto" type="checkbox" /> Add the photo later (attach a gray “UPLOAD IMAGE” placeholder)</label>`;

  const modal = openModal({
    title: "Add to Barcode Library",
    body,
    wide: false,
    buttons: [
      { label: "Cancel" },
      { label: "Add to library", kind: "primary", action: (m) => save(m) },
    ],
  });
  const root = modal.el;
  const $ = (id) => root.querySelector("#" + id);

  const refresh = () => {
    const item = $("lb-item").value.trim();
    $("lb-other-wrap").hidden = item !== "Other";
    root.querySelectorAll("[data-items]").forEach((el) => {
      if (el.id === "lb-pack-wrap") return;
      el.hidden = !el.dataset.items.split("|").includes(item);
    });
    // colour is nested inside the size block: show it on its own list
    const colorWrap = root.querySelector('label[data-items*="Shirt"]');
    if (colorWrap) colorWrap.hidden = !COLOR_ITEMS.includes(item);
    $("lb-pack-wrap").hidden = !PACK_UNITS.includes($("lb-cu").value);
    $("lb-ibc-wrap").hidden = $("lb-btype").value !== "Container";
    const per = gallonsPerVolume($("lb-uv").value, $("lb-uvu").value);
    const pack = PACK_UNITS.includes($("lb-cu").value) ? Number($("lb-pack").value) || 1 : 1;
    $("lb-gal").textContent = per > 0 ? `≈ ${Math.round(per * pack * 1000) / 1000} gallons per counted unit` : "";
  };
  root.addEventListener("input", refresh);
  root.addEventListener("change", refresh);
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-scan]");
    if (!b) return;
    const txt = await scanOnce("Point the camera at the barcode");
    if (txt) { $(b.dataset.scan).value = txt; refresh(); }
  });
  refresh();

  async function save(m) {
    const v = (id) => $(id).value.trim();
    const container = v("lb-btype") === "Container";
    const scanned = v("lb-barcode");
    const itemBarcode = container ? v("lb-item-barcode") : scanned;
    if (!scanned) throw new Error("Scan or type the barcode.");
    if (container && !itemBarcode) throw new Error("Scan the barcode of one item inside the container.");
    if (findLib(itemBarcode)) throw new Error(`${itemBarcode} is already in the library.`);
    if (!v("lb-cat")) throw new Error("Choose an item category.");
    let item = v("lb-item");
    if (!item) throw new Error("Choose the item.");
    if (item === "Other") { item = v("lb-other"); if (!item) throw new Error("Type the item name."); }
    if (!v("lb-make")) throw new Error("Enter the make.");
    const rawItem = v("lb-item");
    if (SIZE_ITEMS.includes(rawItem) && !v("lb-size")) throw new Error("Choose a size.");
    const photo = $("lb-photo").files[0] || null;
    if (!photo && !$("lb-nophoto").checked) throw new Error("Take a photo, or tick “Add the photo later”.");

    const uv = Number(v("lb-uv")) || 0;
    const uvu = v("lb-uvu");
    const cu = v("lb-cu");
    const pack = PACK_UNITS.includes(cu) ? Math.round(Number(v("lb-pack"))) || null : null;
    const hasVol = VOLUME_ITEMS.includes(rawItem) && uv > 0 && uvu;
    const gal = hasVol ? Math.round(gallonsPerVolume(uv, uvu) * (pack || 1) * 1000) / 1000 : null;
    const attrs = {
      barcode: itemBarcode,
      barcode_scan: scanned,
      barcode_type: container ? "Container" : "Item",
      item_barcode: container ? itemBarcode : null,
      item_category: v("lb-cat"),
      item,
      make: v("lb-make"),
      model: v("lb-model") || null,
      description: v("lb-desc") || null,
      size: SIZE_ITEMS.includes(rawItem) ? v("lb-size") || null : null,
      color: COLOR_ITEMS.includes(rawItem) ? v("lb-color") || null : null,
      medical_non: rawItem === "Gloves" ? v("lb-med") || null : null,
      glove_type: rawItem === "Gloves" ? v("lb-gtype") || null : null,
      glove_thickness: rawItem === "Gloves" ? v("lb-gthick") || null : null,
      mask: rawItem === "Mask" ? v("lb-mask") || null : null,
      wipe_count: rawItem === "Disinfectant Wipes" && v("lb-wipes") ? Number(v("lb-wipes")) : null,
      qty_per_pallet: v("lb-pallet") ? Number(v("lb-pallet")) : null,
      count_unit: cu || null,
      units_per_pack: pack,
      unit_volume: hasVol ? uv : null,
      unit_volume_uom: hasVol ? uvu : null,
      gallons_per_count_unit: gal,
      // older fields kept in step so existing popups / the Lookup page keep working
      volume: hasVol ? uv : null,
      Volume_type: hasVol ? LEGACY_VOLUME_TYPE[uvu] || null : null,
    };
    const names = new Map((S.info.lib.fields || []).map((f) => [f.name.toLowerCase(), f.name]));
    const fitted = {};
    for (const [k, val] of Object.entries(attrs)) {
      const real = names.get(k.toLowerCase());
      if (real && val !== null && val !== undefined && val !== "") fitted[real] = val;
    }
    const resp = await applyEdits(S.urls.lib, { adds: [{ attributes: fitted }] });
    const oid = resp.addResults && resp.addResults[0] && resp.addResults[0].objectId;
    let photoNote = "";
    try {
      if (oid) await addAttachment(S.urls.lib, oid, photo || (await makePlaceholderFile()));
    } catch (err) {
      photoNote = ` (photo not attached: ${err.message})`;
    }
    const row = { ...fitted, [S.info.lib.objectIdField || "OBJECTID"]: oid, _oid: oid };
    indexLibrary([...S.library, row]);
    loadLibrary().catch(() => {});
    toast(`Added ${item} to the Barcode Library.${photoNote}`, photoNote ? "info" : "success");
    if (onSaved) onSaved(row);
  }
  return modal;
}

/** Library row -> short display text. */
export const libTitle = (lib) => {
  if (!lib) return "";
  const parts = [ci(lib, "item"), ci(lib, "make"), ci(lib, "model")].map((x) => String(x ?? "").trim()).filter(Boolean);
  return parts.join(" · ");
};
