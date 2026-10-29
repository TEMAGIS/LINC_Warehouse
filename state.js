// Shared in-memory state for the whole app (one object, no framework).
import { ci } from "./units.js";
import { esc } from "./shared/util.js";

export const S = {
  profile: null,
  me: { name: "", first: "", last: "", email: "", username: "" },
  isAdmin: false,   // Inventory Administrator (Users layer)
  canEdit: false,   // may change things: role allows it AND the ArcGIS account can edit the layers
  layerCanEdit: false, // the ArcGIS account can add Transactions / edit Inventory Balance
  role: "",         // "Administrator" | "Staff" | "View only"
  usersReady: false, // the Users table exists in the shipments service
  users: [],        // warehouse user list rows
  myRow: null,      // the signed-in person's row in the user list (null when none)
  owners: [],       // property owners [{code, name, ...}] from the Owners table
  ownersReady: false, // the Owners table exists in the shipments service
  tab: "stock",
  urls: { bal: "", txn: "", lib: "" },
  itemUsed: {},     // layer key -> ArcGIS item id actually opened (editable, or the view-only fallback)
  usingView: {},    // layer key -> reason, when the view-only copy had to be used
  info: { bal: null, txn: null, lib: null },   // getLayerInfo results (fields, objectIdField, capabilities)
  balances: [],
  txns: [],
  library: [],
  libIdx: {},          // barcode -> library row
  shipments: { url: "", headerId: 0, linesId: 1, headers: [], lines: [], ready: false },
  pending: [],         // transactions written this session that haven't confirmed yet
  render: {},          // tab -> render function
  actions: {},         // cross-module hooks (refresh, openStage, ...)
};

export const normSku = (v) => String(v ?? "").trim();

/** Barcode Library row for a scanned/stored barcode. Tolerates leading-zero differences (UPC-A vs EAN-13). */
export function findLib(code) {
  const c = normSku(code);
  if (!c) return null;
  if (S.libIdx[c]) return S.libIdx[c];
  const stripped = c.replace(/^0+/, "");
  if (stripped && S.libIdx[stripped]) return S.libIdx[stripped];
  for (const pad of [c.padStart(12, "0"), c.padStart(13, "0"), c.padStart(14, "0")]) if (S.libIdx[pad]) return S.libIdx[pad];
  return null;
}

export function indexLibrary(rows) {
  S.library = rows;
  S.libIdx = {};
  for (const r of rows) {
    const b = normSku(ci(r, "barcode"));
    if (b && !S.libIdx[b]) S.libIdx[b] = r;
  }
}

/** Best display name for a balance / transaction row. */
export const itemName = (r) => String(r.item || (findLib(r.item_sku) && ci(findLib(r.item_sku), "item")) || r.item_sku || "(unknown)").trim();

export const blank = (v) => v === null || v === undefined || String(v).trim() === "";
export const sameLot = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

/** Pieces for showing an item: generic names ("Other") lead with make / model instead. */
export function itemParts(r, lib) {
  const name = itemName(r);
  const pick = (f) => String(r[f] || (lib && ci(lib, f)) || "").trim();
  const make = pick("make"), model = pick("model"), desc = pick("description");
  const generic = /^(other|misc|miscellaneous|unknown|\(unknown\))$/i.test(name);
  const mm = [make, model].filter(Boolean).join(" · ");
  return { name, make, model, desc, generic: generic && !!mm, mm, title: generic && mm ? mm : name };
}

/** Title + detail lines for the Item column. */
export function itemCell(r, lib) {
  const p = itemParts(r, lib);
  const details = [p.generic ? "" : p.mm, p.desc.length > 90 ? p.desc.slice(0, 87) + "…" : p.desc].filter(Boolean).join(" · ");
  return `<span class="t">${esc(p.title)}</span>${p.generic ? ` <span class="tag">${esc(p.name)}</span>` : ""}<div class="sub">${esc(r.item_sku || "")}</div>${details ? `<div class="sub">${esc(details)}</div>` : ""}`;
}
