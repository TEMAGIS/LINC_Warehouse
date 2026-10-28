// ---------------------------------------------------------------------------
// Camera barcode scanning. Uses the browser's BarcodeDetector where available
// (Chrome/Android, recent Safari); otherwise lazy-loads ZXing only when someone taps
// Scan. Needs HTTPS (GitHub Pages is). Hardware wedge scanners need none of this:
// they type into the focused box and press Enter.
// ---------------------------------------------------------------------------

const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

function loadZxing() {
  if (typeof window.ZXing !== "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = ZXING_URL;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("could not load the scanner library"));
    document.head.appendChild(s);
  });
}

let overlay = null;
let session = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "scan-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="scan-box" role="dialog" aria-modal="true" aria-label="Scan a barcode">
      <video id="scan-video" playsinline muted></video>
      <div class="scan-reticle" aria-hidden="true"></div>
      <div class="scan-status" id="scan-status" role="status"></div>
      <button type="button" id="scan-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#scan-cancel").addEventListener("click", () => stopScan());
  return overlay;
}

export function stopScan() {
  if (!session) {
    if (overlay) overlay.hidden = true;
    return;
  }
  const s = session;
  session = null;
  if (s.timer) clearInterval(s.timer);
  if (s.reader) { try { s.reader.reset(); } catch { /* ignore */ } }
  if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
  const video = overlay && overlay.querySelector("#scan-video");
  if (video) video.srcObject = null;
  if (overlay) overlay.hidden = true;
  s.resolve(null);
}

/** Opens the camera; resolves with the scanned text, or null if cancelled / unavailable. */
export function scanOnce(prompt = "Point the camera at a barcode") {
  if (session) stopScan();
  const el = ensureOverlay();
  const video = el.querySelector("#scan-video");
  const status = el.querySelector("#scan-status");
  status.textContent = prompt;
  el.hidden = false;
  return new Promise(async (resolve) => {
    session = { resolve, timer: null, reader: null, stream: null };
    const s = session;
    const done = (text) => {
      if (session !== s) return;
      session = null;
      if (s.timer) clearInterval(s.timer);
      if (s.reader) { try { s.reader.reset(); } catch { /* ignore */ } }
      if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      el.hidden = true;
      resolve(String(text ?? "").trim());
    };
    try {
      if ("BarcodeDetector" in window) {
        s.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        video.srcObject = s.stream;
        await video.play();
        const detector = new window.BarcodeDetector();
        s.timer = setInterval(async () => {
          try {
            const codes = await detector.detect(video);
            if (codes.length) done(codes[0].rawValue);
          } catch { /* frame not ready yet */ }
        }, 250);
      } else {
        await loadZxing();
        s.reader = new window.ZXing.BrowserMultiFormatReader();
        await s.reader.decodeFromVideoDevice(null, video, (result) => { if (result) done(result.getText()); });
      }
    } catch (e) {
      status.textContent = `Camera unavailable: ${e && e.message ? e.message : e}. Type the code instead.`;
    }
  });
}
