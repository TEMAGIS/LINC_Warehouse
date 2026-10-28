// ---------------------------------------------------------------------------
// Sign-in flow shared by the Request form and the Console:
//   1. OAuth (PKCE) with ArcGIS Online            (arcgis-auth.js)
//   2. The person is the ArcGIS account itself: full name + email come from
//      the account profile. No other user list is needed.
//   3. Optional gate: an email allowlist and/or a probe that the account can
//      open a protected service (the console probes the Inventory service).
// Pages must contain: #sign-in-screen #sign-in-btn #login-error
//   #not-provisioned-screen #not-provisioned-message #np-signout-btn
//   #user-label #sign-out-btn
// ---------------------------------------------------------------------------

import * as auth from "./arcgis-auth.js";
import { $ } from "./util.js";
import { setStatus } from "./ui.js";

const show = (id, on) => {
  const el = document.getElementById(id);
  if (el) el.hidden = !on;
};

function showSignIn(message = "") {
  show("sign-in-screen", true);
  show("not-provisioned-screen", false);
  const err = $("#login-error");
  if (err) err.textContent = message;
}

function blocked(message) {
  setStatus("");
  show("not-provisioned-screen", true);
  $("#not-provisioned-message").textContent = message;
}

/**
 * @param {object} opts
 * @param {string[]} [opts.allowedEmails]  non-empty = only these emails (case-insensitive)
 * @param {()=>Promise<void>} [opts.probe] throws if this account can't open what it needs
 * @param {string} [opts.noAccessMessage]  shown when probe fails
 * @param {(ctx:{me:object, profile:object})=>Promise<void>|void} opts.onReady
 */
export async function startSession({ allowedEmails = [], probe = null, noAccessMessage = "", onReady }) {
  let started = false;

  const signOutAll = () => {
    auth.signOut();
    window.location.reload();
  };
  $("#sign-out-btn")?.addEventListener("click", signOutAll);
  $("#np-signout-btn")?.addEventListener("click", signOutAll);

  const proceed = async () => {
    if (started) return;
    show("sign-in-screen", false);
    setStatus("Signing you in…");
    try {
      const profile = await auth.fetchProfile();
      const email = ((profile && profile.email) || "").trim();
      if (!email) {
        return blocked("Your ArcGIS account has no email address on it, which this app needs to identify your requests. Add one in your ArcGIS profile and sign in again.");
      }
      const me = {
        name: ((profile && profile.fullName) || auth.getUsername() || email).trim(),
        email,
        username: auth.getUsername() || "",
        section: "",
        edisonId: "",
      };
      if (allowedEmails.length && !allowedEmails.map((e) => e.toLowerCase()).includes(email.toLowerCase())) {
        return blocked(`${email} isn't on the list of people allowed into this page.`);
      }
      if (probe) {
        try {
          await probe();
        } catch (err) {
          if (err && (err.code === 498 || err.code === 499)) throw err;
          console.warn("Access probe failed:", err);
          return blocked(noAccessMessage || "Your ArcGIS account can't open the data this page needs.");
        }
      }
      started = true;
      const label = $("#user-label");
      if (label) label.textContent = me.name;
      show("sign-out-btn", true);
      setStatus("");
      await onReady({ me, profile });
    } catch (err) {
      console.error(err);
      if (err && (err.code === 498 || err.code === 499 || /token/i.test(err.message || ""))) {
        auth.signOut();
        setStatus("");
        showSignIn("Your session expired — please sign in again.");
        return;
      }
      setStatus(`Could not start: ${err.message}`, "error");
    }
  };

  $("#sign-in-btn")?.addEventListener("click", async () => {
    try {
      $("#login-error").textContent = "";
      await auth.startSignIn(); // standalone: navigates away; iframe: resolves after popup
      if (auth.isSignedIn()) await proceed();
    } catch (err) {
      $("#login-error").textContent = err.message;
    }
  });

  let result;
  try {
    result = await auth.boot();
  } catch (err) {
    showSignIn(err.message);
    auth.prepareAuthUrl().catch(() => {});
    return;
  }
  if (result === "popup") return;
  if (auth.isSignedIn()) {
    await proceed();
  } else {
    showSignIn();
    auth.prepareAuthUrl().catch(() => {});
  }
}
