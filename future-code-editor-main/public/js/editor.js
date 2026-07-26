/**
 * editor.js  v9
 *
 * Execution is fully delegated to piston.js.
 * editor.js only grabs the code from Monaco and calls Piston.run().
 * All runtime tables, retry logic, and fallback live in piston.js.
 *
 * Load order in chat.html (before </body>):
 *   <script src="js/editor.js"></script>
 *   <script src="js/piston.js"></script>
 *   <script src="js/chat.js"></script>
 *
 * Global alias at the bottom:  function runCode() { Editor.runCode(); }
 */

const Editor = (() => {

  // ── Private state ─────────────────────────────────────────────────────────────
  let _monaco    = null;
  let _projectId = null;
  let _username  = null;
  let _running   = false;
  let _cryptoKey = null;

  // ── Extension → Monaco language string ───────────────────────────────────────
  const EXT_TO_LANG = {
    js:   "javascript",  jsx:  "javascript",
    ts:   "typescript",  tsx:  "typescript",
    py:   "python",
    c:    "c",           h:    "c",
    cpp:  "cpp",         cc:   "cpp",  cxx: "cpp",  hpp: "cpp",
    java: "java",
    rs:   "rust",
    go:   "go",
    rb:   "ruby",
    php:  "php",
    cs:   "csharp",
    kt:   "kotlin",
    swift:"swift",
    html: "html",        htm:  "html",
    css:  "css",         scss: "scss",
    json: "json",
    md:   "markdown",
    sh:   "shell",       bash: "shell",
    sql:  "sql",
    xml:  "xml",
    yaml: "yaml",        yml:  "yaml",
    txt:  "plaintext",
  };

  // ── Blocked local path roots ──────────────────────────────────────────────────
  const BLOCKED_ROOTS = [
    /^[A-Za-z]:[\\\/]$/,
    /^[\\\/]$/,
    /^[\\\/]etc[\\\/]?$/i,
    /^[\\\/]windows[\\\/]?$/i,
    /^[\\\/]system32[\\\/]?$/i,
    /^[\\\/]bin[\\\/]?$/i,
    /^[\\\/]usr[\\\/]?$/i,
    /^[\\\/]boot[\\\/]?$/i,
  ];

  // ═══════════════════════════════════════════════════════════════════════════════
  // ENCRYPTION  (AES-256-GCM, Web Crypto API — no external lib)
  // ═══════════════════════════════════════════════════════════════════════════════

  async function _deriveKey(passphrase) {
    const enc = new TextEncoder();
    const raw = await crypto.subtle.importKey(
      "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    _cryptoKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode("hybridscript-salt-v1"), iterations: 100_000, hash: "SHA-256" },
      raw,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function _encrypt(plaintext) {
    if (!_cryptoKey) return plaintext;
    const enc      = new TextEncoder();
    const iv       = crypto.getRandomValues(new Uint8Array(12));
    const ct       = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, _cryptoKey, enc.encode(plaintext));
    const combined = new Uint8Array(iv.byteLength + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), iv.byteLength);
    return btoa(String.fromCharCode(...combined));
  }

  async function _decrypt(b64) {
    if (!_cryptoKey) return b64;
    try {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) }, _cryptoKey, bytes.slice(12)
      );
      return new TextDecoder().decode(plain);
    } catch { return b64; }  // legacy / unencrypted content
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // JSZip DYNAMIC LOADER
  // ═══════════════════════════════════════════════════════════════════════════════

  function _ensureJSZip() {
    return new Promise((resolve, reject) => {
      if (typeof JSZip !== "undefined") { resolve(); return; }
      const s   = document.createElement("script");
      s.src     = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload  = resolve;
      s.onerror = () => reject(new Error("JSZip CDN failed to load — check your internet connection"));
      document.head.appendChild(s);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════════

  function init(projectId, username) {
    _projectId = projectId;
    _username  = username;

    // Optional encryption key from /config → FILE_KEY in .env
    fetch("/config")
      .then(r => r.json())
      .then(cfg => { if (cfg.fileKey) return _deriveKey(cfg.fileKey); })
      .catch(() => {});

    _ensureJSZip().catch(() => {});

    require.config({
      paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs" },
    });
    require(["vs/editor/editor.main"], _onMonacoReady);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // MONACO SETUP
  // ═══════════════════════════════════════════════════════════════════════════════

  function _onMonacoReady() {
    monaco.editor.defineTheme("vscode-dark-plus", {
      base: "vs-dark", inherit: true,
      rules: [
        { token: "comment",  foreground: "6a9955", fontStyle: "italic" },
        { token: "keyword",  foreground: "569cd6" },
        { token: "string",   foreground: "ce9178" },
        { token: "number",   foreground: "b5cea8" },
        { token: "type",     foreground: "4ec9b0" },
        { token: "function", foreground: "dcdcaa" },
        { token: "variable", foreground: "9cdcfe" },
      ],
      colors: {
        "editor.background":              "#1e1e1e",
        "editor.foreground":              "#d4d4d4",
        "editor.lineHighlightBackground": "#2a2a2a",
        "editor.selectionBackground":     "#264f78",
        "editorCursor.foreground":        "#aeafad",
        "editorLineNumber.foreground":    "#858585",
        "editorIndentGuide.background":   "#404040",
      },
    });

    _monaco = monaco.editor.create(document.getElementById("monacoEditor"), {
      value:                      "",
      language:                   "plaintext",
      theme:                      "vscode-dark-plus",
      fontSize:                   14,
      fontFamily:                 "'JetBrains Mono','Cascadia Code','Fira Code',Consolas,monospace",
      fontLigatures:              true,
      lineHeight:                 22,
      minimap:                    { enabled: true },
      scrollBeyondLastLine:       false,
      automaticLayout:            true,
      tabSize:                    2,
      insertSpaces:               true,
      wordWrap:                   "off",
      renderLineHighlight:        "gutter",
      cursorBlinking:             "smooth",
      cursorSmoothCaretAnimation: "on",
      smoothScrolling:            true,
      padding:                    { top: 8, bottom: 8 },
      quickSuggestions:           { other: true, comments: true, strings: true },
      bracketPairColorization:    { enabled: true },
      guides:                     { bracketPairs: true, indentation: true },
      folding:                    true,
      suggest:                    { showKeywords: true },
    });

    _monaco.onDidChangeCursorPosition(e => {
      const el = document.getElementById("statusCursor");
      if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    });

    _monaco.onDidChangeModelContent(() => {
      const el = document.getElementById("statusSaved");
      if (el) el.textContent = "● Unsaved";
    });

    _monaco.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (typeof FileManager !== "undefined") FileManager.saveCurrentFile(_monaco.getValue());
    });

    _monaco.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote, toggleTerminal);

    if (typeof CRDT !== "undefined") CRDT.attachEditor(_monaco);

    document.dispatchEvent(new Event("monaco-ready"));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // FILE LOADING
  // ═══════════════════════════════════════════════════════════════════════════════

  async function loadFile(file) {
    if (!_monaco) return;
    if (!file) {
      _monaco.setValue("");
      monaco.editor.setModelLanguage(_monaco.getModel(), "plaintext");
      _setStatusLang("Plain Text");
      _setBreadcrumb("—");
      return;
    }
    const lang    = langFromFilename(file.name);
    const content = await _decrypt(file.content || "");
    _monaco.setValue(content);
    monaco.editor.setModelLanguage(_monaco.getModel(), lang);
    _setStatusLang(_cap(lang));
    _setBreadcrumb(file.name);
    const sel = document.getElementById("languageSelect");
    if (sel) sel.value = lang;
    const saved = document.getElementById("statusSaved");
    if (saved) saved.textContent = "✓ Saved";
    if (typeof CRDT !== "undefined") {
      CRDT.setActiveFile(file.name);
      setTimeout(() => CRDT.forceBroadcast(), 150);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SAVE TO MONGODB
  // ═══════════════════════════════════════════════════════════════════════════════

  async function saveFile(filename, content) {
    if (!_projectId || !_username) { UI.toast("Not connected to a project", "error"); return; }

    const encrypted = await _encrypt(content);

    console.log("SAVE:", filename, "len:", content?.length);

    try {
      const res = await fetch(
        `/projects/${_projectId}/files/${encodeURIComponent(filename)}`,
        {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ username: _username, content: encrypted }),
        }
      );
      const data = await res.json();

      console.log("SAVE RESPONSE:", data);

      if (data.success) {
        const el = document.getElementById("statusSaved");
        if (el) el.textContent = "✓ Saved";
        UI.toast(data.status === "pending_approval" ? "Submitted for approval" : "Saved", "success");
      } else {
        UI.toast(data.message || "Save failed", "error");
      }
    } catch (err) {
      UI.toast("Save error: " + err.message, "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // CODE EXECUTION  — delegated entirely to piston.js
  // ═══════════════════════════════════════════════════════════════════════════════
  //
  // All execution logic (Piston primary + Gemini fallback) lives in piston.js.
  // editor.js only needs to:
  //   1. Grab the code and filename from the Monaco instance.
  //   2. Call Piston.run() which handles everything and prints to the terminal.
  //
  // To add a language, edit RUNTIMES in piston.js — nothing here changes.

  async function runCode() {
    if (_running) { UI.toast("Already running…", "info"); return; }
    if (!_monaco)  { UI.toast("Editor not ready", "error");  return; }

    const code     = _monaco.getValue();
    const filename = (typeof FileManager !== "undefined"
                       ? FileManager.getActiveFilename() : null) || "main.js";
    const lang     = langFromFilename(filename);

    console.log("CODE:", code?.slice(0, 80));
    console.log("LANG:", lang);

    _running = true;
    document.getElementById("runBtn")?.classList.add("running");

    try {
      // Piston.run() calls POST /execute on the backend.
      // All execution logic (Piston API + Gemini fallback) is on the server.
      if (typeof Piston !== "undefined") {
        await Piston.run(code, lang, filename);
      } else {
        _termClear();
        _termPrint("piston.js not loaded. Add <script src=\"js/piston.js\"></script> before chat.js in chat.html.\n", "term-error");
      }
    } catch (err) {
      _termClear();
      _termPrint("Unexpected error: " + err.message + "\n", "term-error");
    } finally {
      _running = false;
      document.getElementById("runBtn")?.classList.remove("running");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ZIP EXPORT
  // ═══════════════════════════════════════════════════════════════════════════════

  async function exportZip(projectName, files) {
    if (!files || files.length === 0) { UI.toast("No files to export", "info"); return; }

    const panel = document.getElementById("terminalPanel");
    if (panel?.classList.contains("hidden")) toggleTerminal();
    _termClear();
    _termPrint("📦  Building ZIP…\n", "term-info");

    try { await _ensureJSZip(); }
    catch (e) {
      UI.toast("JSZip failed to load — check internet", "error");
      _termPrint("✗  " + e.message + "\n", "term-error");
      return;
    }

    const zip    = new JSZip();
    const folder = zip.folder(projectName || "project");
    for (const f of files) {
      folder.file(f.name, await _decrypt(f.content || ""));
      _termPrint(`   + ${f.name}\n`, "term-info");
    }

    try {
      const blob     = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const safeName = (projectName || "project").replace(/[^\w\-. ]/g, "_");
      const a        = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob), download: safeName + ".zip",
      });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      _termPrint(`\n✓  Downloaded "${safeName}.zip"  (${(blob.size / 1024).toFixed(1)} KB)\n`, "term-ok");
      UI.toast("Downloaded " + safeName + ".zip", "success");
    } catch (e) {
      _termPrint("✗  ZIP failed: " + e.message + "\n", "term-error");
      UI.toast("ZIP export failed", "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // LOCAL PATH SAVE
  // ═══════════════════════════════════════════════════════════════════════════════

  async function saveToLocalPath(projectPath, files) {
    if (!projectPath) { UI.toast("No local path set", "error"); return; }

    if (!_isPathSafe(projectPath)) {
      UI.toast("Path rejected — system root or protected directory", "error");
      _termPrint(`✗  Blocked: "${projectPath}"\n   Use a path inside your home or projects folder.\n`, "term-error");
      return;
    }

    const panel = document.getElementById("terminalPanel");
    if (panel?.classList.contains("hidden")) toggleTerminal();
    _termClear();
    _termPrint(`💾  Saving to ${projectPath}…\n`, "term-info");

    const plainFiles = await Promise.all(
      (files || []).map(async f => ({ name: f.name, content: await _decrypt(f.content || "") }))
    );

    try {
      const res  = await fetch("/local/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body:   JSON.stringify({ path: projectPath, files: plainFiles }),
      });
      const data = await res.json();
      if (data.success) {
        (data.saved  || []).forEach(f => _termPrint(`   ✓  ${f}\n`,           "term-ok"));
        (data.errors || []).forEach(e => _termPrint(`   ✗  ${e.file}: ${e.error}\n`, "term-error"));
        UI.toast("Saved to local path", "success");
      } else {
        _termPrint("✗  " + (data.message || "Save failed") + "\n", "term-error");
        UI.toast(data.message || "Save failed", "error");
      }
    } catch (err) {
      _termPrint("✗  " + err.message + "\n", "term-error");
      UI.toast("Network error: " + err.message, "error");
    }
  }

  function _isPathSafe(p) {
    const n = p.trim().replace(/\\/g, "/");
    return !BLOCKED_ROOTS.some(rx => rx.test(n));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // TERMINAL
  // ═══════════════════════════════════════════════════════════════════════════════

  function toggleTerminal() {
    const panel = document.getElementById("terminalPanel");
    if (!panel) return;
    const hidden = panel.classList.toggle("hidden");
    if (!hidden) _termPrint("Terminal ready. Press ▶ Run to execute.\n", "term-info");
    layout();
  }

  function _termEl()    { return document.getElementById("terminalOutput"); }
  function _termClear() { const el = _termEl(); if (el) el.innerHTML = ""; }
  function _termPrint(text, cls) {
    const el = _termEl();
    if (!el) return;
    const span = document.createElement("span");
    if (cls) span.className = "term-line " + cls;
    span.textContent = text;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW FILE MODAL
  // ═══════════════════════════════════════════════════════════════════════════════

  function openNewFileModal() {
    const modal = document.getElementById("newFileModal");
    const input = document.getElementById("newFileNameInput");
    const err   = document.getElementById("newFileError");
    if (!modal) return;
    if (input) input.value = "";
    if (err)   err.style.display = "none";
    modal.classList.remove("hidden");
    setTimeout(() => input?.focus(), 40);
  }

  function _bindNewFileModal() {
    const modal     = document.getElementById("newFileModal");
    const input     = document.getElementById("newFileNameInput");
    const createBtn = document.getElementById("newFileCreateBtn");
    const cancelBtn = document.getElementById("newFileCancelBtn");
    const closeBtn  = document.getElementById("newFileCloseBtn");
    const errEl     = document.getElementById("newFileError");

    const close = () => modal?.classList.add("hidden");
    cancelBtn?.addEventListener("click", close);
    closeBtn?.addEventListener("click",  close);
    modal?.addEventListener("click", e => { if (e.target === modal) close(); });

    const doCreate = async () => {
      const name = input?.value.trim();
      if (!name) {
        if (errEl) { errEl.textContent = "Enter a filename"; errEl.style.display = "block"; } return;
      }
      if (!/\.[a-z0-9]+$/i.test(name)) {
        if (errEl) { errEl.textContent = "Include a file extension (e.g. .js, .py)"; errEl.style.display = "block"; } return;
      }
      close();
      if (typeof FileManager !== "undefined") await FileManager.createFile(name);
    };

    createBtn?.addEventListener("click", doCreate);
    input?.addEventListener("keypress", e => { if (e.key === "Enter") doCreate(); });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // EVENT BINDING  (called by chat.js after "monaco-ready")
  // ═══════════════════════════════════════════════════════════════════════════════

  function bindEditorEvents() {
    document.getElementById("newFileBtn")
      ?.addEventListener("click", openNewFileModal);

    document.getElementById("exportZipBtn")
      ?.addEventListener("click", () => {
        if (typeof FileManager === "undefined") { UI.toast("Editor not ready", "error"); return; }
        const name = (typeof activeProject !== "undefined" ? activeProject?.name : null) || "project";
        exportZip(name, FileManager.getAllFiles());
      });

    document.getElementById("saveBtn")
      ?.addEventListener("click", () => {
        if (typeof FileManager !== "undefined") FileManager.saveCurrentFile(_monaco.getValue());
      });

    document.getElementById("runBtn")
      ?.addEventListener("click", runCode);

    document.getElementById("terminalToggleBtn")
      ?.addEventListener("click", toggleTerminal);

    document.getElementById("languageSelect")
      ?.addEventListener("change", e => setLanguage(e.target.value));

    _bindNewFileModal();
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════════

  function langFromFilename(filename) {
    const ext = (filename || "").split(".").pop().toLowerCase();
    return EXT_TO_LANG[ext] || "plaintext";
  }

  function setLanguage(lang) {
    if (!_monaco) return;
    monaco.editor.setModelLanguage(_monaco.getModel(), lang);
    _setStatusLang(_cap(lang));
  }

  function getValue() { return _monaco?.getValue() ?? ""; }
  function layout()   { _monaco?.layout(); }

  function _setStatusLang(label) {
    const el = document.getElementById("statusLang");
    if (el) el.textContent = label;
  }
  function _setBreadcrumb(name) {
    const el = document.getElementById("breadcrumbFile");
    if (el) el.textContent = name || "—";
  }
  function _cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════════

  return {
    init,
    loadFile,
    saveFile,
    langFromFilename,
    setLanguage,
    getValue,
    layout,
    toggleTerminal,
    runCode,
    exportZip,
    saveToLocalPath,
    bindEditorEvents,
    openNewFileModal,
    encrypt: _encrypt,
    decrypt: _decrypt,
  };

})();

// ── GLOBAL ALIAS ──────────────────────────────────────────────────────────────
// Needed because HTML has:  onclick="runCode()"  and  onclick="Editor.toggleTerminal()"
// Functions inside the IIFE are not on window — this bridges the gap.
function runCode() { Editor.runCode(); }