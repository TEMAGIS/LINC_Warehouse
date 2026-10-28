// ---------------------------------------------------------------------------
// Unit labels and approximate gallons, driven by the Barcode Library.
//   new fields:   count_unit, units_per_pack, unit_volume, unit_volume_uom, gallons_per_count_unit
//   legacy fields: volume + Volume_type (volume of ONE item), still used when the new ones are blank
// Pure functions over a library row; no DOM, no network.
// ---------------------------------------------------------------------------
import { VOLUME_UOMS, PACK_UNITS } from "./lists.js";

/** Case-insensitive field read (hosted layers vary: objectid / OBJECTID, Volume_type ...). */
export function ci(row, name) {
  if (!row) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(row)) if (k.toLowerCase() === want) return row[k];
  return undefined;
}

export const fmtNum = (v) => {
  if (v === undefined || v === null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : String(v);
};

export function fmtGallons(g) {
  return g >= 100 ? Math.round(g).toLocaleString("en-US") : (Math.round(g * 10) / 10).toLocaleString("en-US");
}

/** Gallons in `volume` of unit `type` (oz, mL, L, qt, gal, pt ...). 0 when unknown. */
export function gallonsPerVolume(volume, type) {
  const v = Number(volume);
  if (!(v > 0)) return 0;
  const t = String(type ?? "").trim().toLowerCase();
  const exact = VOLUME_UOMS.find((u) => u.value.toLowerCase() === t);
  if (exact) return v * exact.gallons;
  if (/gal/.test(t)) return v;
  if (/\bml\b|milli/.test(t)) return v * 0.000264172;
  if (/\bl\b|lit(er|re)/.test(t)) return v * 0.264172;
  if (/quart|\bqt/.test(t)) return v * 0.25;
  if (/pint|\bpt/.test(t)) return v * 0.125;
  if (/oz|ounce/.test(t)) return v / 128;
  return 0;
}

export const isWaterName = (name) => /\bwater\b/i.test(String(name ?? ""));

/** Gallons held by ONE counted unit of this library row (0 if unknown). */
export function gallonsPerCountUnit(lib) {
  if (!lib) return 0;
  const direct = Number(ci(lib, "gallons_per_count_unit"));
  if (direct > 0) return direct;
  const uv = Number(ci(lib, "unit_volume"));
  const uom = ci(lib, "unit_volume_uom");
  if (uv > 0 && uom) {
    const per = gallonsPerVolume(uv, uom);
    const pack = PACK_UNITS.includes(String(ci(lib, "count_unit") ?? "")) ? Number(ci(lib, "units_per_pack")) || 1 : 1;
    return per * pack;
  }
  // legacy: volume of one item, counted per item
  if (isWaterName(ci(lib, "item"))) return gallonsPerVolume(ci(lib, "volume"), ci(lib, "volume_type"));
  return 0;
}

export const gallonsFor = (lib, qty) => gallonsPerCountUnit(lib) * (Number(qty) || 0);

/** Short unit line: "Case of 24", "Each", else the old "16.9 Oz each". */
export function unitLabel(lib, fallback = "") {
  if (lib) {
    const cu = String(ci(lib, "count_unit") ?? "").trim();
    if (cu) {
      const n = Number(ci(lib, "units_per_pack"));
      return PACK_UNITS.includes(cu) && n > 0 ? `${cu} of ${n}` : cu;
    }
    const v = Number(ci(lib, "volume"));
    const t = String(ci(lib, "volume_type") ?? "").trim();
    if (v > 0 && t) return `${fmtNum(v)} ${t} each`;
  }
  return String(fallback ?? "").trim();
}

/** Value to store in a transaction's unit_of_measure for this item. */
export function uomForTxn(lib) {
  return unitLabel(lib, "");
}
