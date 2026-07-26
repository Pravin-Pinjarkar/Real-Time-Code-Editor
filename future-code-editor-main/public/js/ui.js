/**
 * ui.js — Shared UI utilities used across all pages.
 * Import this before any page-specific JS.
 */

const UI = {

  /** Safely escape text for innerHTML */
  escape(text) {
    const d = document.createElement("div");
    d.textContent = String(text ?? "");
    return d.innerHTML;
  },

  /** First letter of a name, uppercased */
  initial(name) {
    return name ? String(name).charAt(0).toUpperCase() : "?";
  },

  /** Format bytes into human-readable string */
  formatBytes(bytes) {
    if (!bytes) return "0 B";
    if (bytes < 1024)    return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  },

  /** Show an inline message element */
  showMessage(elementId, text, type = "info") {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent  = text;
    el.className    = "message " + type;
    el.style.display = "block";
  },

  hideMessage(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.style.display = "none";
  },

  /** Toggle a spinner */
  showSpinner(elementId, show) {
    const el = document.getElementById(elementId);
    if (el) el.classList.toggle("hidden", !show);
  },

  /**
   * Display a floating toast notification.
   * type: 'success' | 'error' | 'info'
   */
  toast(text, type = "info", durationMs = 3200) {
    const t = document.createElement("div");
    t.className = "toast toast-" + type;
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("toast-visible"));
    setTimeout(() => {
      t.classList.remove("toast-visible");
      setTimeout(() => t.remove(), 300);
    }, durationMs);
  },

  /** Map file extension → Monaco language string */
  langFromFilename(filename) {
    const ext = (filename || "").split(".").pop().toLowerCase();
    return {
      js: "javascript", ts: "typescript", py: "python",
      html: "html", css: "css", json: "json",
      cpp: "cpp", c: "c", java: "java",
      rs: "rust", go: "go", md: "markdown", sql: "sql",
    }[ext] || "plaintext";
  },

  /** Map extension → short badge label */
  badgeFromFilename(filename) {
    const ext = (filename || "").split(".").pop().toLowerCase();
    return ext.toUpperCase().slice(0, 4) || "TXT";
  },

  /** CSS class for the file-icon badge */
  iconClassFromFilename(filename) {
    const ext = (filename || "").split(".").pop().toLowerCase();
    const known = ["js","ts","py","html","css","json","cpp","java","rs","go","md","sql"];
    return known.includes(ext) ? ext : "txt";
  },

};
