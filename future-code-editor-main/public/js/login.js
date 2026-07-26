/**
 * login.js — Handles Clerk authentication on the login page.
 * Depends on: api.js, ui.js
 */

window.addEventListener("load", async () => {
  // Already logged in → skip straight to dashboard
  if (localStorage.getItem("chatUser")) {
    UI.showMessage("msg", "Already signed in. Redirecting...", "success");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 700);
    return;
  }

  try {
    const config = await API.getConfig();
    await loadClerkScript(config.clerkPublishableKey);
    await window.Clerk.load();

    // Clerk already has an active session
    if (window.Clerk.user) {
      await handleSignedIn();
      return;
    }

    // Mount Clerk's built-in widget (Google, email code, etc.)
    window.Clerk.mountSignIn(document.getElementById("clerk-sign-in"), {
      routing: "hash",
    });

    // React to successful sign-in
    window.Clerk.addListener(async ({ user }) => {
      if (user) await handleSignedIn();
    });

  } catch (err) {
    console.error("Clerk load error:", err);
    UI.showMessage("msg", "❌ Failed to load auth. Please refresh.", "error");
  }
});

/** Inject Clerk script dynamically from the key's embedded domain */
function loadClerkScript(publishableKey) {
  const stripped   = publishableKey.replace("pk_test_", "").replace("pk_live_", "");
  const frontendApi = atob(stripped).replace(/\$$/, "");

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://" + frontendApi + "/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
    script.setAttribute("data-clerk-publishable-key", publishableKey);
    script.crossOrigin = "anonymous";
    script.onload  = resolve;
    script.onerror = () => reject(new Error("Clerk script load failed"));
    document.head.appendChild(script);
  });
}

/** Called once Clerk confirms the user is signed in */
async function handleSignedIn() {
  try {
    UI.showSpinner("loadingSpinner", true);
    UI.showMessage("msg", "Signing you in...", "info");

    const sessionToken = await window.Clerk.session.getToken({ template: null });
    const data = await API.verifyClerkSession(sessionToken);

    if (data.success) {
      localStorage.setItem("chatUser",  data.username);
      localStorage.setItem("chatEmail", data.email);
      UI.showMessage("msg", "✅ Success! Redirecting...", "success");
      setTimeout(() => { window.location.href = "dashboard.html"; }, 900);
    } else {
      UI.showMessage("msg", data.message || "❌ Login failed", "error");
    }
  } catch (err) {
    console.error("Sign-in error:", err);
    UI.showMessage("msg", "❌ Network error. Please try again.", "error");
  } finally {
    UI.showSpinner("loadingSpinner", false);
  }
}
