/**
 * public/js/local-path-ui.js
 *
 * Handles the "Set Local Path" modal on the chat/workspace page.
 *
 * Call LocalPathUI.init(projectId, username, currentPath) once at startup.
 * Call LocalPathUI.open() to show the modal.
 * Provides LocalPathUI.getPath() for other modules to read the current path.
 */

const LocalPathUI = (() => {

  let _projectId = null;
  let _username  = null;
  let _path      = null;    // currently set path

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(projectId, username, savedPath) {
    _projectId = projectId;
    _username  = username;
    _path      = savedPath || null;

    _buildModal();
    _bindEvents();

    if (_path) _updatePathDisplay();
  }

  // ── Build modal DOM ───────────────────────────────────────────────────────────
  function _buildModal() {
    if (document.getElementById("localPathModal")) return;

    const modal = document.createElement("div");
    modal.id        = "localPathModal";
    modal.className = "local-path-modal hidden";
    modal.innerHTML = `
      <div class="local-path-content">
        <h3>📁 Local Project Path</h3>
        <p style="font-size:12px;color:var(--text-dim);margin-bottom:14px">
          Set a directory on this machine where project files will be saved.
          Use an absolute path (e.g. <code style="font-family:var(--font-code)">C:\\Users\\you\\projects\\myapp</code> or <code>/home/you/projects/myapp</code>).
        </p>
        <div class="local-path-input-row">
          <input
            type="text"
            id="localPathInput"
            class="local-path-input"
            placeholder="/home/user/projects/my-app"
          >
          <button class="local-path-validate-btn" id="localPathValidateBtn">Check</button>
        </div>
        <div id="localPathStatus" class="local-path-status"></div>
        <div class="local-path-footer">
          <button class="local-path-mkdir-btn" id="localPathMkdirBtn">Create Directory</button>
          <button class="local-path-close-btn" id="localPathCloseBtn">Cancel</button>
          <button class="local-path-save-btn"  id="localPathSaveBtn">Set Path & Save Files</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // ── Events ────────────────────────────────────────────────────────────────────
  function _bindEvents() {
    document.getElementById("localPathCloseBtn")?.addEventListener("click", close);

    document.getElementById("localPathValidateBtn")?.addEventListener("click", _validate);

    document.getElementById("localPathInput")?.addEventListener("keypress", e => {
      if (e.key === "Enter") _validate();
    });

    document.getElementById("localPathMkdirBtn")?.addEventListener("click", _mkdir);

    document.getElementById("localPathSaveBtn")?.addEventListener("click", _saveAndClose);

    // Click backdrop to close
    document.getElementById("localPathModal")?.addEventListener("click", e => {
      if (e.target.id === "localPathModal") close();
    });
  }

  // ── Validate path via backend ─────────────────────────────────────────────────
  async function _validate() {
    const inputEl = document.getElementById("localPathInput");
    const status  = document.getElementById("localPathStatus");
    const input   = inputEl?.value.trim();

    if (!input) {
      _setStatus("Please enter a path", "error"); return;
    }

    _setStatus("Checking…", "warn");

    try {
      const res  = await fetch("/local/validate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ path: input }),
      });
      const data = await res.json();

      if (!data.success) {
        _setStatus(data.message || "Validation failed", "error"); return;
      }

      if (!data.exists) {
        _setStatus(`Path does not exist yet. Click "Create Directory" to make it, or it will be created on save.`, "warn");
      } else if (!data.isDirectory) {
        _setStatus("This path points to a file, not a folder. Please use a directory.", "error");
      } else if (!data.writable) {
        _setStatus("Directory exists but is not writable. Check permissions.", "error");
      } else {
        _setStatus(`✓ Directory exists and is writable.\n${data.resolved}`, "ok");
      }
    } catch (err) {
      _setStatus("Network error: " + err.message, "error");
    }
  }

  // ── Create directory ──────────────────────────────────────────────────────────
  async function _mkdir() {
    const input = document.getElementById("localPathInput")?.value.trim();
    if (!input) { _setStatus("Enter a path first", "error"); return; }

    _setStatus("Creating directory…", "warn");

    try {
      const res  = await fetch("/local/mkdir", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ path: input }),
      });
      const data = await res.json();

      if (data.success) {
        _setStatus(`✓ Created: ${data.resolved}`, "ok");
      } else {
        _setStatus(data.message || "Failed to create directory", "error");
      }
    } catch (err) {
      _setStatus("Network error: " + err.message, "error");
    }
  }

  // ── Save path + write files ───────────────────────────────────────────────────
  async function _saveAndClose() {
    const input = document.getElementById("localPathInput")?.value.trim();
    if (!input) { _setStatus("Enter a path first", "error"); return; }

    // Save path to project in DB
    try {
      await fetch(`/projects/${_projectId}/path`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: _username, localPath: input }),
      });
    } catch {}

    _path = input;
    _updatePathDisplay();

    // Save all files to local path via Editor.saveToLocalPath
    if (typeof Editor !== "undefined" && typeof FileManager !== "undefined") {
      const files = FileManager.getAllFiles().map(f => ({ name: f.name, content: f.content || "" }));
      await Editor.saveToLocalPath(input, files);
    }

    close();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function _setStatus(msg, type) {
    const el = document.getElementById("localPathStatus");
    if (!el) return;
    el.textContent = msg;
    el.className   = "local-path-status " + (type || "");
  }

  function _updatePathDisplay() {
    const el  = document.getElementById("localPathDisplay");
    const bar = document.getElementById("localPathBar");
    if (el)  el.textContent = _path || "Not set";
    if (bar) bar.style.display = _path ? "flex" : "none";
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function open() {
    const modal = document.getElementById("localPathModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    const input = document.getElementById("localPathInput");
    if (input) { input.value = _path || ""; input.focus(); }
    document.getElementById("localPathStatus").className = "local-path-status";
  }

  function close() {
    document.getElementById("localPathModal")?.classList.add("hidden");
  }

  function getPath() { return _path; }

  return { init, open, close, getPath };
})();