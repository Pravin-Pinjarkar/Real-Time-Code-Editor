/**
 * public/js/ai-panel.js
 *
 * GenAI assistant panel — lightweight, optional.
 * Communicates with /ai/chat on the backend (Groq + Gemini).
 *
 * Usage: included in chat.html after ui.js.
 * Call AIPanel.init() once at page load.
 * Call AIPanel.toggle() to show/hide.
 */

const AIPanel = (() => {

  let _history = [];   // { role: "user"|"assistant", content: string }[]
  let _open    = false;

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    _buildDOM();
    _bindEvents();
  }

  // ── Build panel DOM ──────────────────────────────────────────────────────────
  function _buildDOM() {
    if (document.getElementById("aiPanel")) return;  // already built

    const panel = document.createElement("div");
    panel.id        = "aiPanel";
    panel.className = "ai-panel hidden";
    panel.innerHTML = `
      <div class="ai-panel-header">
        <div class="ai-panel-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
          AI Assistant
        </div>
        <div class="ai-panel-actions">
          <button class="ai-panel-btn" id="aiClearBtn" title="Clear chat">✕ Clear</button>
          <button class="ai-panel-btn" id="aiCloseBtn" title="Close">⊠</button>
        </div>
      </div>
      <div class="ai-messages" id="aiMessages">
        <div class="ai-welcome">
          <div class="ai-welcome-icon">🤖</div>
          <p>Ask me anything about your code!</p>
          <div class="ai-suggestions">
            <button class="ai-suggest-btn" data-q="Explain this code">Explain this code</button>
            <button class="ai-suggest-btn" data-q="Find bugs in this code">Find bugs</button>
            <button class="ai-suggest-btn" data-q="How can I optimize this?">Optimize</button>
            <button class="ai-suggest-btn" data-q="Write unit tests for this">Write tests</button>
          </div>
        </div>
      </div>
      <div class="ai-input-area">
        <label class="ai-context-toggle">
          <input type="checkbox" id="aiIncludeContext" checked>
          <span>Include current file</span>
        </label>
        <div class="ai-input-row">
          <textarea
            id="aiInput"
            class="ai-input"
            placeholder="Ask about your code…"
            rows="2"
          ></textarea>
          <button id="aiSendBtn" class="ai-send-btn" title="Send (Ctrl+Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
  }

  // ── Events ───────────────────────────────────────────────────────────────────
  function _bindEvents() {
    // Close button
    document.getElementById("aiCloseBtn")?.addEventListener("click", close);

    // Clear
    document.getElementById("aiClearBtn")?.addEventListener("click", () => {
      _history = [];
      const msgs = document.getElementById("aiMessages");
      if (msgs) msgs.innerHTML = `<div class="ai-sys-msg">Chat cleared.</div>`;
    });

    // Send on button click
    document.getElementById("aiSendBtn")?.addEventListener("click", _send);

    // Send on Ctrl+Enter
    document.getElementById("aiInput")?.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        _send();
      }
    });

    // Suggestion pills
    document.getElementById("aiMessages")?.addEventListener("click", e => {
      const btn = e.target.closest(".ai-suggest-btn");
      if (btn) {
        document.getElementById("aiInput").value = btn.dataset.q;
        _send();
      }
    });
  }

  // ── Send message ─────────────────────────────────────────────────────────────
  async function _send() {
    const input = document.getElementById("aiInput");
    const text  = input?.value.trim();
    if (!text) return;
    input.value = "";

    // Remove welcome screen
    document.querySelector(".ai-welcome")?.remove();

    // Add user bubble
    _addMessage("user", text);
    _history.push({ role: "user", content: text });

    // Get editor context if checkbox is checked
    let context = null;
    const includeCtx = document.getElementById("aiIncludeContext")?.checked;
    if (includeCtx && typeof Editor !== "undefined") {
      const code = Editor.getValue();
      const file = typeof FileManager !== "undefined" ? FileManager.getActiveFilename() : "";
      if (code) context = (file ? `// ${file}\n` : "") + code;
    }

    // Show loading bubble
    const loadingId = "ai-loading-" + Date.now();
    _addLoading(loadingId);

    try {
      const res = await fetch("/ai/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          message: text,
          context,
          history: _history.slice(-8),
        }),
      });

      const data = await res.json();
      _removeLoading(loadingId);

      if (data.success) {
        _addMessage("assistant", data.reply);
        _history.push({ role: "assistant", content: data.reply });
      } else {
        _addError(data.message || "AI service error");
      }

    } catch (err) {
      _removeLoading(loadingId);
      _addError("Network error: " + err.message);
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  function _addMessage(role, content) {
    const container = document.getElementById("aiMessages");
    if (!container) return;

    const el = document.createElement("div");
    el.className = "ai-message ai-message-" + role;

    // Simple markdown: code blocks, bold, inline code
    const html = _renderMarkdown(content);

    el.innerHTML = `
      <div class="ai-avatar">${role === "user" ? "You" : "AI"}</div>
      <div class="ai-bubble">${html}</div>
    `;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function _addLoading(id) {
    const container = document.getElementById("aiMessages");
    if (!container) return;
    const el = document.createElement("div");
    el.id = id;
    el.className = "ai-message ai-message-assistant";
    el.innerHTML = `
      <div class="ai-avatar">AI</div>
      <div class="ai-bubble ai-thinking">
        <span></span><span></span><span></span>
      </div>
    `;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function _removeLoading(id) {
    document.getElementById(id)?.remove();
  }

  function _addError(msg) {
    const container = document.getElementById("aiMessages");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "ai-sys-msg ai-sys-error";
    el.textContent = "⚠ " + msg;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  // Very minimal markdown renderer (no external dep)
  function _renderMarkdown(text) {
    let html = UI.escape(text);

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="ai-code-block"><code class="lang-${lang || "plain"}">${code}</code></pre>`
    );

    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');

    // Bold: **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Line breaks
    html = html.replace(/\n/g, "<br>");

    return html;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function toggle() {
    _open = !_open;
    const panel = document.getElementById("aiPanel");
    if (_open) { panel?.classList.remove("hidden"); document.getElementById("aiInput")?.focus(); }
    else         panel?.classList.add("hidden");
  }

  function open()  { _open = true;  document.getElementById("aiPanel")?.classList.remove("hidden"); }
  function close() { _open = false; document.getElementById("aiPanel")?.classList.add("hidden"); }

  return { init, toggle, open, close };
})();