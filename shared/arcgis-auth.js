// ---------------------------------------------------------------------------
// ArcGIS OAuth sign-in — authorization-code flow with PKCE, implemented
// directly against ArcGIS Online's REST endpoints (no ArcGIS Maps SDK).
// Same pattern as the Assigned Inventory Editor: each page's own URL is the
// registered Redirect URI and doubles as its own OAuth callback — boot()
// detects a `?code=...` on load. Standalone = full-page redirect; inside an
// iframe (e.g. Experience Builder Embed) = popup relayed via postMessage.
// ---------------------------------------------------------------------------

import { CONFIG } from "../config.js";

const AUTHORIZE_URL = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/oauth2/authorize`;
const TOKEN_URL = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/oauth2/token`;
const MESSAGE_TYPE = "aic_oauth";
const POPUP_NAME = "aic_oauth_popup";

let TOKEN = null; // { accessToken, refreshToken, expiresAt, refreshExpiresAt, username, fullName, email }
let refreshInFlight = null;

/** The redirect URI for THIS page: config override, else this page's folder URL. */
export function redirectUri() {
  if (CONFIG.ARCGIS_REDIRECT_URI) return CONFIG.ARCGIS_REDIRECT_URI;
  return window.location.origin + window.location.pathname.replace(/[^/]*$/, "");
}

// --- PKCE helpers ---
function base64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(byteLen = 48) {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return base64url(arr);
}
async function sha256base64url(s) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return base64url(new Uint8Array(hash));
}

// --- Token cache (localStorage) ---
function loadStoredToken() {
  try {
    const raw = localStorage.getItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (!t.accessToken || !t.expiresAt) return null;
    // A token issued to a different OAuth app can't be refreshed with this app's
    // client ID ("Invalid client_id"), so ignore it and make the person sign in again.
    if (t.clientId !== CONFIG.ARCGIS_APP_ID) {
      localStorage.removeItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY);
      return null;
    }
    return t;
  } catch {
    return null;
  }
}
function saveToken(t) {
  TOKEN = t;
  try {
    localStorage.setItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY, JSON.stringify(t));
  } catch {
    /* storage blocked: token stays in memory for this page only */
  }
}
function clearStoredToken() {
  TOKEN = null;
  try {
    localStorage.removeItem(CONFIG.ARCGIS_TOKEN_STORAGE_KEY);
    sessionStorage.removeItem("aic_oauth_verifier");
    sessionStorage.removeItem("aic_oauth_state");
  } catch {
    /* ignore */
  }
}
function tokenFromResponse(data) {
  const now = Date.now();
  const expSec = Number(data.expires_in) || 7200;
  const refSec = Number(data.refresh_token_expires_in) || 0;
  return {
    clientId: CONFIG.ARCGIS_APP_ID,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || (TOKEN && TOKEN.refreshToken) || null,
    expiresAt: now + expSec * 1000,
    refreshExpiresAt: refSec ? now + refSec * 1000 : (TOKEN && TOKEN.refreshExpiresAt) || null,
    username: data.username || (TOKEN && TOKEN.username) || null,
    fullName: (TOKEN && TOKEN.fullName) || null,
    email: (TOKEN && TOKEN.email) || null,
  };
}

function isInIframe() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

async function buildAuthorizeUrl() {
  const verifier = randomString(48);
  const challenge = await sha256base64url(verifier);
  const state = randomString(16);
  sessionStorage.setItem("aic_oauth_verifier", verifier);
  sessionStorage.setItem("aic_oauth_state", state);
  const params = new URLSearchParams({
    client_id: CONFIG.ARCGIS_APP_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    expiration: String(CONFIG.ARCGIS_TOKEN_EXPIRATION_MINUTES),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function exchangeCodeForToken(code) {
  const verifier = sessionStorage.getItem("aic_oauth_verifier");
  if (!verifier) throw new Error("Missing PKCE verifier — please sign in again.");
  const params = new URLSearchParams({
    client_id: CONFIG.ARCGIS_APP_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    f: "json",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) {
    const msg = (data.error.details && data.error.details[0]) || data.error.message || "Sign-in failed";
    throw new Error(msg);
  }
  if (!data.access_token) throw new Error("No access token returned");
  sessionStorage.removeItem("aic_oauth_verifier");
  sessionStorage.removeItem("aic_oauth_state");
  return tokenFromResponse(data);
}

/** Error that session.js treats as "sign in again" (code 498), never as "no access". */
function sessionExpired(message) {
  const e = new Error(message);
  e.code = 498;
  return e;
}

async function refreshAccessTokenNow() {
  if (!TOKEN || !TOKEN.refreshToken) throw sessionExpired("No refresh token available");
  if (TOKEN.refreshExpiresAt && Date.now() > TOKEN.refreshExpiresAt) throw sessionExpired("Refresh token expired");
  const params = new URLSearchParams({
    client_id: CONFIG.ARCGIS_APP_ID,
    grant_type: "refresh_token",
    refresh_token: TOKEN.refreshToken,
    f: "json",
  });
  const res = await fetch(TOKEN_URL, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw sessionExpired(data.error.message || "Token refresh failed");
  if (!data.access_token) throw sessionExpired("No access token in refresh response");
  return tokenFromResponse(data);
}

/** Refreshes the token if it is close to expiry. Concurrent callers share one refresh. */
export async function ensureFreshToken() {
  if (!TOKEN) throw new Error("Not signed in");
  if (TOKEN.expiresAt && Date.now() < TOKEN.expiresAt - CONFIG.ARCGIS_REFRESH_BUFFER_MS) return;
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessTokenNow()
      .then((fresh) => saveToken(fresh))
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export function getToken() {
  return TOKEN ? TOKEN.accessToken : null;
}
export function getUsername() {
  return TOKEN ? TOKEN.username : null;
}
export function isSignedIn() {
  return !!TOKEN;
}
export function signOut() {
  clearStoredToken();
}

/** Signed-in user's name + email (and org id) from ArcGIS's community/self endpoint. */
export async function fetchProfile() {
  if (!TOKEN) return null;
  if (TOKEN.fullName && TOKEN.email && TOKEN.orgId !== undefined) {
    return { fullName: TOKEN.fullName, email: TOKEN.email, username: TOKEN.username };
  }
  try {
    const url = `${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/community/self?f=json&token=${encodeURIComponent(TOKEN.accessToken)}`;
    const res = await fetch(url);
    const data = await res.json();
    const fullName = data.fullName || [data.firstName, data.lastName].filter(Boolean).join(" ").trim() || null;
    TOKEN.fullName = fullName || TOKEN.username;
    TOKEN.email = data.email || null;
    TOKEN.orgId = data.orgId || null;
    TOKEN.role = data.role || null; // org_admin / org_publisher / org_user …
    saveToken(TOKEN);
  } catch (err) {
    console.warn("Could not fetch ArcGIS profile (name/email):", err);
  }
  return { fullName: TOKEN.fullName, email: TOKEN.email, username: TOKEN.username, role: TOKEN.role };
}

/**
 * Call once on page load. Handles a `?code=...` redirect (as popup: relay to
 * opener and close; as top-level app: exchange the code) and loads any stored token.
 * @returns {Promise<"popup"|"redirected"|null>}
 */
export async function boot() {
  TOKEN = loadStoredToken();

  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (!code && !error) return null;

  if (window.opener && window.opener !== window) {
    try {
      window.opener.postMessage(
        { type: MESSAGE_TYPE, code, state, error, error_description: url.searchParams.get("error_description") || null },
        window.location.origin
      );
    } catch (e) {
      console.error("postMessage to opener failed:", e);
    }
    setTimeout(() => {
      try {
        window.close();
      } catch {}
    }, 50);
    document.body.innerHTML =
      '<div style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#333">Sign-in complete. You can close this window.</div>';
    return "popup";
  }

  if (error) {
    history.replaceState({}, "", url.pathname);
    throw new Error(`Sign-in error: ${url.searchParams.get("error_description") || error}`);
  }
  const expectedState = sessionStorage.getItem("aic_oauth_state");
  if (expectedState && state !== expectedState) {
    history.replaceState({}, "", url.pathname);
    throw new Error("Sign-in failed: state mismatch. Please try again.");
  }
  try {
    const tok = await exchangeCodeForToken(code);
    saveToken(tok);
    history.replaceState({}, "", url.pathname);
    return "redirected";
  } catch (err) {
    history.replaceState({}, "", url.pathname);
    throw err;
  }
}

let preparedAuthUrl = null;
/** Pre-builds the authorize URL so a click can open the popup synchronously. */
export async function prepareAuthUrl() {
  preparedAuthUrl = await buildAuthorizeUrl();
  return preparedAuthUrl;
}

/**
 * Starts sign-in. Standalone: redirects the page (never resolves). In an
 * iframe: opens a popup and resolves once sign-in completes.
 */
export function startSignIn() {
  if (CONFIG.ARCGIS_APP_ID.startsWith("REPLACE_")) {
    return Promise.reject(new Error("ARCGIS_APP_ID is not set in shared/config.js yet — see the README (step 1)."));
  }
  if (isInIframe()) {
    return new Promise((resolve, reject) => {
      const w = 480,
        h = 640;
      const left = Math.max(0, (screen.width - w) / 2);
      const top = Math.max(0, (screen.height - h) / 2);
      const popup = window.open(
        "about:blank",
        POPUP_NAME,
        `width=${w},height=${h},left=${left},top=${top},toolbar=0,menubar=0,scrollbars=1`
      );
      if (!popup) {
        reject(new Error("Popup was blocked — please allow popups for this site, then try again."));
        return;
      }
      try {
        popup.document.write(
          "<!doctype html><meta charset='utf-8'><title>Signing in…</title>" +
            "<style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#333}</style>" +
            "<div>Connecting to ArcGIS Online…</div>"
        );
      } catch {}
      const urlPromise = preparedAuthUrl ? Promise.resolve(preparedAuthUrl) : buildAuthorizeUrl();
      urlPromise
        .then((u) => {
          popup.location.href = u;
        })
        .catch((err) => {
          try {
            popup.close();
          } catch {}
          reject(err);
        });

      let settled = false;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        clearInterval(closedTimer);
      };
      const onMessage = async (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.type !== MESSAGE_TYPE) return;
        settled = true;
        cleanup();
        if (event.data.error) {
          reject(new Error(event.data.error_description || event.data.error));
          return;
        }
        try {
          saveToken(await exchangeCodeForToken(event.data.code));
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      window.addEventListener("message", onMessage);
      const closedTimer = setInterval(() => {
        if (popup.closed && !settled) {
          cleanup();
          reject(new Error("Sign-in window was closed."));
        }
      }, 500);
    });
  }

  const urlPromise = preparedAuthUrl ? Promise.resolve(preparedAuthUrl) : buildAuthorizeUrl();
  return urlPromise.then((u) => {
    window.location.href = u;
  });
}
