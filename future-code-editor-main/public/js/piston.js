/**
 * piston.js  (frontend module)
 *
 * Single responsibility: call POST /execute on the backend and
 * render ONLY the program output into #terminalOutput.
 *
 * All Piston API logic, retry, and Gemini fallback live on the backend
 * (routes/execute.js). This file is purely a UI adapter.
 *
 * Usage: Piston.run(code, lang, filename)
 * Called by editor.js runCode().
 */

const Piston = (() => {

  // ── Terminal helpers ──────────────────────────────────────────────────────────

  function _el()    { return document.getElementById("terminalOutput"); }
  function _clear() { const e = _el(); if (e) e.innerHTML = ""; }

  function _write(text, cls) {
    const container = _el();
    if (!container || !text) return;
    const span = document.createElement("span");
    span.className   = cls ? "term-line " + cls : "term-line";
    span.textContent = text;
    container.appendChild(span);
    container.scrollTop = container.scrollHeight;
  }

  function _openTerminal() {
    const panel = document.getElementById("terminalPanel");
    if (panel && panel.classList.contains("hidden")) {
      panel.classList.remove("hidden");
      if (typeof Editor !== "undefined") Editor.layout();
    }
  }

  // ── Public: run ───────────────────────────────────────────────────────────────

  async function run(code, lang, filename) {
    _openTerminal();
    _clear();

    if (!code || !code.trim()) {
      _write("Nothing to run — file is empty.\n", "term-warn");
      return;
    }

    try {
      const res = await fetch("/execute", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code, language: lang, filename }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        _write("Server error " + res.status + (body ? ": " + body.slice(0, 200) : "") + "\n", "term-error");
        return;
      }

      const data = await res.json();

      // stdout — normal program output
      if (data.stdout) {
        _write(data.stdout.trimEnd() + "\n", "");
      }

      // stderr — errors / compile failures
      if (data.stderr) {
        _write(data.stderr.trimEnd() + "\n", "term-error");
      }

      // Nothing printed at all
      if (!data.stdout && !data.stderr) {
        _write("(no output)\n", "term-info");
      }

      // Status line
      _write(
        "\n" + (data.success ? "✓  Done" : "✗  Failed") + "\n",
        data.success ? "term-ok" : "term-warn"
      );

    } catch (err) {
      _write("Network error: " + err.message + "\n", "term-error");
      _write("Make sure the backend server is running.\n", "term-info");
    }
  }

  return { run };

})();