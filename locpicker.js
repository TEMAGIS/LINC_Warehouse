// ---------------------------------------------------------------------------
// Location suggestions for the From / To boxes. Click or arrow-key through places the app already
// knows about instead of typing or scanning a code. Typing and scanning still work as before.
//
//   kind "from": locations that currently hold stock (with what's in them)
//   kind "to":   locations holding the same item, recent put-aways, other stocked locations,
//                pick-line lanes, and bays pinned on the map (picking a bay fills its prefix; add level + position)
// ---------------------------------------------------------------------------
import { S, normSku, itemName } from "./state.js";
import { balanceCode, codeLabel, parseCode, picklineLanes, cleanScan } from "./loc.js";
import { onHand } from "./data.js";
import { bayLabel } from "./locations.js";
import { esc } from "./shared/util.js";

const MAX_SHOWN = 8;
const recent = []; // put-away / destination codes used this session, newest first

export function rememberLocation(code) {
  const c = cleanScan(code);
  if (!c) return;
  const i = recent.indexOf(c);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(c);
  recent.length = Math.min(recent.length, 10);
}

/** Everything we could suggest, as code -> {code, bay, label, tag, detail, score, hay}. Lower score = shown earlier. */
function candidates(kind, preferSkus, excludeCode) {
  const prefer = new Set((preferSkus || []).map(normSku).filter(Boolean));
  const out = new Map();

  // locations that hold stock
  const stock = new Map();
  for (const r of S.balances) {
    const q = onHand(r);
    if (q <= 0) continue;
    const code = balanceCode(r);
    if (!parseCode(code)) continue;
    const e = stock.get(code) || [];
    e.push({ sku: normSku(r.item_sku), name: itemName(r), qty: q });
    stock.set(code, e);
  }
  for (const [code, items] of stock) {
    const same = items.find((i) => prefer.has(i.sku));
    const shown = items.slice(0, 2).map((i) => `${i.qty} × ${i.name}`).join(" · ") + (items.length > 2 ? ` · +${items.length - 2} more` : "");
    out.set(code, {
      code, bay: false, label: codeLabel(code),
      tag: same ? (kind === "from" ? "Has this item" : "Same item here") : kind === "from" ? "" : "In use",
      detail: shown,
      score: same ? 0 : 3,
      hay: `${code} ${items.map((i) => `${i.name} ${i.sku}`).join(" ")}`.toLowerCase(),
    });
  }
  if (kind === "from") return finish(out, excludeCode);

  // recent destinations
  recent.forEach((code, i) => {
    const e = out.get(code);
    if (e) { e.score = Math.min(e.score, 1 + i / 100); e.tag = e.tag === "Same item here" ? e.tag : "Recent"; return; }
    if (!parseCode(code)) return;
    out.set(code, { code, bay: false, label: codeLabel(code), tag: "Recent", detail: "Empty", score: 1 + i / 100, hay: code.toLowerCase() });
  });

  // pick-line lanes
  for (const l of picklineLanes()) {
    const e = out.get(l.code);
    if (e) { e.tag = "Pick line"; continue; }
    out.set(l.code, { code: l.code, bay: false, label: l.label, tag: "Pick line", detail: `Lane ${l.lane}`, score: 4, hay: `${l.code} pick line lane ${l.lane}`.toLowerCase() });
  }

  // bays on the map (a bay isn't a full location: it has no level / position yet)
  for (const b of S.locations || []) {
    if (!b.active || !b.bay || out.has(b.bay)) continue;
    out.set(b.bay, { code: b.bay, bay: true, label: bayLabel(b.bay), tag: b.type || "Bay", detail: `${b.label && b.label !== bayLabel(b.bay) ? b.label + " · " : ""}Whole bay: pick it, then add level and position`, score: 6, hay: `${b.bay} ${b.label} ${b.type} ${b.notes}`.toLowerCase() });
  }
  return finish(out, excludeCode);
}

function finish(map, excludeCode) {
  if (excludeCode) map.delete(cleanScan(excludeCode));
  return [...map.values()];
}

/** Filters + orders candidates for what has been typed so far. */
function search(all, query) {
  const raw = String(query || "").trim();
  if (!raw) return all.slice().sort((a, b) => a.score - b.score || a.code.localeCompare(b.code));
  const qc = cleanScan(raw);
  const ws = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const c of all) {
    let rank = -1;
    if (qc && c.code.startsWith(qc)) rank = 0;
    else if (qc && c.code.includes(qc)) rank = 1;
    else if (ws.every((w) => c.hay.includes(w))) rank = 2;
    if (rank >= 0) hits.push({ c, rank });
  }
  return hits.sort((a, b) => a.rank - b.rank || a.c.score - b.c.score || a.c.code.localeCompare(b.c.code)).map((h) => h.c);
}

/**
 * Wires a suggestion list to the scan box `id` inside `root`. Needs a <div id="{id}-sug"> after the box
 * (dialogs.js locBox renders it).
 * opts: kind "from"|"to"; prefer() -> SKUs to rank first; exclude() -> a code to leave out; onPick(code) after a full code is chosen.
 */
export function attachLocationSuggest(root, id, { kind = "to", prefer = () => [], exclude = () => "", onPick = () => {} } = {}) {
  const input = root.querySelector("#" + id);
  const list = root.querySelector("#" + id + "-sug");
  if (!input || !list) return;
  let shown = [];
  let active = -1;

  const close = () => { list.hidden = true; list.innerHTML = ""; shown = []; active = -1; };

  const highlight = (i) => {
    active = i;
    list.querySelectorAll(".loc-opt").forEach((b, n) => {
      b.classList.toggle("active", n === i);
      b.setAttribute("aria-selected", n === i ? "true" : "false");
      if (n === i) b.scrollIntoView({ block: "nearest" });
    });
  };

  const open = () => {
    const found = search(candidates(kind, prefer(), exclude()), input.value);
    shown = found.slice(0, MAX_SHOWN);
    active = -1;
    if (!shown.length) {
      if (input.value.trim()) {
        list.innerHTML = `<div class="sub">${kind === "from" ? "No stocked location matches. You can still type or scan a code." : "No known location matches. You can still type or scan a full code."}</div>`;
        list.hidden = false;
      } else close();
      return;
    }
    const more = found.length - shown.length;
    list.innerHTML = shown
      .map((c, i) => `<button type="button" class="loc-opt" role="option" aria-selected="false" data-i="${i}"><span class="mono"><strong>${esc(c.label)}</strong></span>${c.tag ? `<span class="loc-tag">${esc(c.tag)}</span>` : ""}${c.detail ? `<span class="sub loc-detail">${esc(c.detail)}</span>` : ""}</button>`)
      .join("") + (more > 0 ? `<div class="sub">${more} more. Keep typing to narrow it down.</div>` : "");
    list.hidden = false;
  };

  const pick = (c) => {
    input.value = c.code;
    if (c.bay) {
      // only a bay prefix: keep typing the level and position
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      return;
    }
    close();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    onPick(c.code);
  };

  input.addEventListener("focus", open);
  input.addEventListener("input", open);
  input.addEventListener("change", close); // typed + Enter, a camera scan, or a pick: done
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (list.hidden) open();
      if (!shown.length) return;
      e.preventDefault();
      const n = shown.length;
      highlight(e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n);
    } else if (e.key === "Enter" && active >= 0 && shown[active]) {
      e.preventDefault();
      e.stopPropagation(); // don't also fire the scan box's own Enter -> change
      pick(shown[active]);
    } else if (e.key === "Escape" && !list.hidden) {
      e.stopPropagation();
      close();
    }
  });
  // pointerdown would blur the box and close the list before the click lands
  list.addEventListener("pointerdown", (e) => { if (e.target.closest(".loc-opt")) e.preventDefault(); });
  list.addEventListener("click", (e) => {
    const b = e.target.closest(".loc-opt");
    if (b && shown[Number(b.dataset.i)]) pick(shown[Number(b.dataset.i)]);
  });
}
