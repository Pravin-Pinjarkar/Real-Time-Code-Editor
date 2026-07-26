/**
 * fileManager.js — Manages project files: list, tabs, create, switch.
 * Talks to API and drives the file tree + tab bar DOM.
 * Depends on: api.js, ui.js, editor.js
 */

const FileManager = (() => {

  let _projectId   = null;
  let _username    = null;
  let _isAdmin     = false;
  let _files       = [];        // { name, language, content, pendingContent, pendingBy }
  let _activeFile  = null;      // filename string
  let _onSwitch    = null;      // callback(file) when active file changes

  // ── Init ────────────────────────────────────────────────────────────────────

  function init(projectId, username, isAdmin, files = [], onSwitchCallback) {
    _projectId  = projectId;
    _username   = username;
    _isAdmin    = isAdmin;
    _files      = files;
    _onSwitch   = onSwitchCallback;

    renderFileTree();
    renderTabs();

    // Open first file automatically
    if (_files.length > 0) switchTo(_files[0].name);
  }

  // ── File list rendering ──────────────────────────────────────────────────────

  function renderFileTree() {
    const list = document.getElementById("fileTree");
    if (!list) return;

    list.innerHTML = _files.map(f => {
      const cls   = UI.iconClassFromFilename(f.name);
      const badge = UI.badgeFromFilename(f.name);
      const hasPending = f.pendingBy && f.pendingContent != null;
      return `
        <li class="tree-item ${_activeFile === f.name ? "active" : ""}"
            data-filename="${UI.escape(f.name)}">
          <span class="file-icon ${cls}">${badge}</span>
          <span class="tree-item-name">${UI.escape(f.name)}</span>
          ${hasPending ? '<span class="pending-dot" title="Pending approval">●</span>' : ""}
        </li>
      `;
    }).join("") || `<li class="tree-empty">No files yet. Click + to create one.</li>`;

    list.querySelectorAll(".tree-item[data-filename]").forEach(item => {
      item.addEventListener("click", () => switchTo(item.dataset.filename));
    });
  }

  // ── Tab bar ──────────────────────────────────────────────────────────────────

  function renderTabs() {
    const tabsList = document.getElementById("tabsList");
    if (!tabsList) return;

    tabsList.innerHTML = _files.map(f => {
      const cls = UI.iconClassFromFilename(f.name);
      return `
        <div class="editor-tab ${_activeFile === f.name ? "active" : ""}"
             data-filename="${UI.escape(f.name)}">
          <span class="tab-icon ${cls}">${UI.badgeFromFilename(f.name)}</span>
          <span>${UI.escape(f.name)}</span>
          <button class="tab-close" data-filename="${UI.escape(f.name)}">×</button>
        </div>
      `;
    }).join("");

    tabsList.querySelectorAll(".editor-tab").forEach(tab => {
      tab.addEventListener("click", e => {
        if (!e.target.classList.contains("tab-close")) switchTo(tab.dataset.filename);
      });
    });

    tabsList.querySelectorAll(".tab-close").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        closeTab(btn.dataset.filename);
      });
    });
  }

  // ── Switch active file ───────────────────────────────────────────────────────

  function switchTo(filename) {
    const file = _files.find(f => f.name === filename);
    if (!file) return;

    _activeFile = filename;

    // Update breadcrumb
    const bc = document.getElementById("breadcrumbFile");
    if (bc) bc.textContent = filename;

    // Update status bar language
    const sl = document.getElementById("statusLang");
    if (sl) sl.textContent = UI.langFromFilename(filename);

    // Re-render tree + tabs to update active states
    renderFileTree();
    renderTabs();

    // Notify editor
    if (_onSwitch) _onSwitch(file);

    // Show pending banner if needed
    renderPendingBanner(file);
  }

  // ── Pending change banner (for admin) ────────────────────────────────────────

  function renderPendingBanner(file) {
    let banner = document.getElementById("pendingBanner");

    if (file.pendingBy && file.pendingContent != null && _isAdmin) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "pendingBanner";
        banner.className = "pending-banner";
        const editorArea = document.querySelector(".editor-area");
        const monacoEl   = document.getElementById("monacoEditor");
        if (editorArea && monacoEl) editorArea.insertBefore(banner, monacoEl);
      }
      banner.innerHTML = `
        <span>⏳ <strong>${UI.escape(file.pendingBy)}</strong> submitted changes for approval</span>
        <div class="pending-actions">
          <button class="approve-btn" id="approveBtn">✓ Approve</button>
          <button class="reject-btn"  id="rejectBtn">✗ Reject</button>
        </div>
      `;

      document.getElementById("approveBtn").addEventListener("click", async () => {
        const res = await API.approveFile(_projectId, _username, file.name);
        if (res.success) {
          file.content        = file.pendingContent;
          file.pendingContent = null;
          file.pendingBy      = null;
          UI.toast("Changes approved", "success");
          renderFileTree();
          renderPendingBanner(file);
        } else {
          UI.toast(res.message || "Approve failed", "error");
        }
      });

      document.getElementById("rejectBtn").addEventListener("click", async () => {
        const res = await API.rejectFile(_projectId, _username, file.name);
        if (res.success) {
          file.pendingContent = null;
          file.pendingBy      = null;
          UI.toast("Changes rejected", "info");
          renderFileTree();
          renderPendingBanner(file);
        }
      });

    } else if (banner) {
      banner.remove();
    }
  }

  // ── Close a tab ──────────────────────────────────────────────────────────────

  function closeTab(filename) {
    // Just switch to another file; we keep files in the project
    const others = _files.filter(f => f.name !== filename);
    if (_activeFile === filename && others.length > 0) {
      switchTo(others[0].name);
    } else if (others.length === 0) {
      _activeFile = null;
      renderFileTree();
      renderTabs();
      if (_onSwitch) _onSwitch(null);
    }
  }

  // ── Create new file ───────────────────────────────────────────────────────────

  async function createFile(filename) {
    if (!filename) return;
    if (_files.find(f => f.name === filename)) {
      UI.toast("File already exists", "error");
      return;
    }

    const res = await API.createFile(_projectId, _username, filename);
    if (res.success) {
      _files.push(res.file);
      renderFileTree();
      renderTabs();
      switchTo(filename);
      UI.toast(filename + " created", "success");
    } else {
      UI.toast(res.message || "Failed to create file", "error");
    }
  }

  // ── Save current file ─────────────────────────────────────────────────────────

  async function saveCurrentFile(content) {
    if (!_activeFile) return;
    const res = await API.saveFile(_projectId, _username, _activeFile, content);

    if (res.success) {
      const file = _files.find(f => f.name === _activeFile);
      if (res.status === "saved") {
        if (file) file.content = content;
        document.getElementById("statusSaved").textContent = "✓ Saved";
        UI.toast("Saved to database", "success");
      } else if (res.status === "pending_approval") {
        if (file) { file.pendingContent = content; file.pendingBy = _username; }
        document.getElementById("statusSaved").textContent = "⏳ Pending";
        UI.toast("Submitted for admin approval", "info");
        renderFileTree();
      }
    } else {
      UI.toast(res.message || "Save failed", "error");
    }
  }

  // ── Public getters ────────────────────────────────────────────────────────────

  function getActiveFile()   { return _files.find(f => f.name === _activeFile) || null; }
  function getActiveFilename() { return _activeFile; }
  function getAllFiles()     { return _files; }

  return { init, switchTo, createFile, saveCurrentFile, getActiveFile, getActiveFilename, getAllFiles };
})();
