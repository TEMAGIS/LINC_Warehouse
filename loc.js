// ---------------------------------------------------------------------------
// Location codes. Same scheme as the Transactions survey: fixed width, 2 characters
// per segment — zone, row, bay, level, position — with the zone left off entirely
// when there isn't one (8 characters instead of 10). Pure functions, no DOM.
// ---------------------------------------------------------------------------
import { CONFIG } from "./config.js";

export const SEG_LABELS = ["Zone", "Row", "Bay", "Level", "Position"];

/** "z1-aa 01.01 p1" -> "Z1AA0101P1" */
export const cleanScan = (raw) => String(raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export const pad2 = (v) => {
  const s = String(v ?? "").trim();
  return /^\d$/.test(s) ? "0" + s : s;
};

/** Splits a scanned code into segments; null when it isn't 8 or 10 characters. */
export function parseCode(raw) {
  const c = cleanScan(raw);
  if (c.length !== 8 && c.length !== 10) return null;
  const z = c.length === 10;
  const o = z ? 2 : 0;
  return {
    code: c,
    zone: z ? c.slice(0, 2) : "",
    row: c.slice(o, o + 2),
    bay: c.slice(o + 2, o + 4),
    level: c.slice(o + 4, o + 6),
    position: c.slice(o + 6, o + 8),
  };
}

/** Code -> "Z1-AA-01-01-P1" */
export function codeLabel(raw) {
  const p = parseCode(raw);
  if (!p) return cleanScan(raw);
  return [p.zone, p.row, p.bay, p.level, p.position].filter(Boolean).join("-");
}

/** Inventory Balance row -> its code (zone, aisle, bay, level, position; blanks skipped). */
export function balanceCode(r) {
  return [r.zone, r.aisle, r.bay, r.level, r.position]
    .map((v) => pad2(v))
    .filter((v) => v !== "")
    .join("")
    .toUpperCase();
}

/** Segment attributes for a Transactions row, e.g. prefix "from_". */
export function txnLocationAttrs(raw, prefix) {
  const p = parseCode(raw);
  if (!p) throw new Error(`"${raw}" isn't a location code (expected 8 or 10 characters).`);
  const label = [p.zone, p.row, p.bay, p.level, p.position].filter(Boolean).join("-");
  const label5 = [p.zone, p.row, p.bay, p.level, p.position].join("-"); // survey concat() keeps the blank zone's dash
  return {
    [`${prefix}location_scan`]: p.code,
    [`${prefix}zone`]: p.zone,
    [`${prefix}row`]: p.row,
    [`${prefix}bay`]: p.bay,
    [`${prefix}level`]: p.level,
    [`${prefix}position`]: p.position,
    [`${prefix}segment`]: label5,
    [`${prefix}location_label`]: label5,
    _label: label,
  };
}

// ---- Pick line ----------------------------------------------------------------

/** Scan code of pick-line lane n (1-based): PL + lane + 01 + 01 + 01. */
export function picklineCode(lane = 1) {
  return `${CONFIG.PICKLINE.ZONE}${String(lane).padStart(2, "0")}010101`;
}

export function picklineLanes() {
  const n = Math.max(1, Number(CONFIG.PICKLINE.LANES) || 1);
  return Array.from({ length: n }, (_, i) => ({ lane: i + 1, code: picklineCode(i + 1), label: codeLabel(picklineCode(i + 1)) }));
}

export const isPicklineZone = (zone) => String(zone ?? "").trim().toUpperCase() === CONFIG.PICKLINE.ZONE;
export const isPicklineCode = (raw) => {
  const p = parseCode(raw);
  return !!p && isPicklineZone(p.zone);
};
export const isPicklineRow = (r) => isPicklineZone(r.zone);
