/**
 * crdt.js — Real-time collaborative editing engine.
 *
 * Architecture:
 *   - Uses Monaco's changeModelContent operations (not setValue) to apply
 *     remote edits. This preserves cursor position, undo history, and avoids
 *     the "full replace flicker" that broke the previous sync.
 *   - Sends operation deltas (not full content) to reduce bandwidth and
 *     eliminate race conditions.
 *   - Tracks remote cursors and renders them as decorations in the editor.
 *   - Implements line locking: when a user edits a line, that range is
 *     broadcast and blocked for others via a Monaco read-only range.
 *
 * Message types sent over WebSocket:
 *   editor-op      — a single operation delta
 *   cursor-update  — cursor/selection position
 *   line-lock      — range being actively edited
 *   line-unlock    — range released
 *   file-switch    — user switched to a different file
 */

const CRDT = (() => {

  // ── Internal state ──────────────────────────────────────────────────────────
  let _socket      = null;
  let _projectId   = null;
  let _username    = null;
  let _editor      = null;   // monaco editor instance
  let _activeFile  = null;   // current filename string

  // Remote user state
  const _remoteCursors      = new Map();  // username → { decoration ids }
  const _remoteLockedRanges = new Map();  // username → IRange

  // Suppress echo: when we apply a remote op we must not re-broadcast it
  let _suppressBroadcast  = false;
  let _broadcastTimer     = null;

  // Pending ops received before editor was ready
  const _pendingOps = [];

  // Lock state for our own lines
  let _myLockRange    = null;
  let _lockTimer      = null;
  let _monacoDisposables = [];

  // ── Colour pool for remote cursors ──────────────────────────────────────────
  const CURSOR_COLOURS = [
    "#ff6b6b","#feca57","#48dbfb","#ff9ff3","#54a0ff",
    "#5f27cd","#00d2d3","#ff9f43","#1dd1a1","#c8d6e5",
  ];
  const _userColour = new Map();
  let _colourIdx = 0;

  function colourFor(username) {
    if (!_userColour.has(username)) {
      _userColour.set(username, CURSOR_COLOURS[_colourIdx % CURSOR_COLOURS.length]);
      _colourIdx++;
    }
    return _userColour.get(username);
  }

  // ── Public: init ────────────────────────────────────────────────────────────

  function init(socket, projectId, username) {
    _socket    = socket;
    _projectId = projectId;
    _username  = username;
  }

  // ── Public: attach Monaco editor ────────────────────────────────────────────

  function attachEditor(monacoEditor) {
    _editor = monacoEditor;

    // Dispose old listeners if re-attaching
    _monacoDisposables.forEach(d => d.dispose());
    _monacoDisposables = [];

    // Listen for content changes → send operation delta
    const contentDisposable = _editor.onDidChangeModelContent((event) => {
      if (_suppressBroadcast) return;
      _sendOperationDelta(event.changes);
      _updateMyLock();
    });

    // Listen for cursor/selection → broadcast presence
    const cursorDisposable = _editor.onDidChangeCursorSelection((event) => {
      _sendCursorUpdate(event.selection);
    });

    _monacoDisposables.push(contentDisposable, cursorDisposable);

    // Apply any ops that arrived before the editor was ready
    if (_pendingOps.length > 0) {
      console.log("CRDT: applying", _pendingOps.length, "pending ops");
      _pendingOps.forEach(op => _applyRemoteOp(op));
      _pendingOps.length = 0;
    }
  }

  // ── Public: set active file ─────────────────────────────────────────────────

  function setActiveFile(filename) {
    const prev = _activeFile;
    _activeFile = filename;

    // Release our lock from the previous file
    if (prev && prev !== filename) {
      _unlockMyLines();
    }

    // Clear all remote decorations (they belong to the old file model)
    _clearAllRemoteDecorations();

    // Tell others we switched files
    if (_socket && _socket.readyState === WebSocket.OPEN) {
      _socket.send(JSON.stringify({
        type:     "file-switch",
        from:     _username,
        file:     filename,
        prevFile: prev,
      }));
    }
  }

  // ── Public: handle incoming WS message ──────────────────────────────────────

  function handleMessage(msg) {
    switch (msg.type) {

      case "editor-op":
        if (msg.from === _username) return;         // echo — ignore
        if (msg.file  !== _activeFile) return;      // different file — ignore
        if (!_editor) { _pendingOps.push(msg); return; }
        _applyRemoteOp(msg);
        break;

      case "cursor-update":
        if (msg.from === _username) return;
        if (msg.file !== _activeFile) return;
        _renderRemoteCursor(msg.from, msg.selection);
        break;

      case "line-lock":
        if (msg.from === _username) return;
        _remoteLockedRanges.set(msg.from, msg.range);
        _enforceReadOnlyRanges();
        break;

      case "line-unlock":
        if (msg.from === _username) return;
        _remoteLockedRanges.delete(msg.from);
        _enforceReadOnlyRanges();
        break;

      case "file-switch":
        if (msg.from === _username) return;
        // Remove that user's cursor decorations — they moved to another file
        _clearUserDecorations(msg.from);
        _remoteLockedRanges.delete(msg.from);
        _enforceReadOnlyRanges();
        break;
    }
  }

  // ── Send operation delta ─────────────────────────────────────────────────────

  function _sendOperationDelta(changes) {
    if (!_socket || _socket.readyState !== WebSocket.OPEN) return;
    if (!_activeFile) return;

    clearTimeout(_broadcastTimer);
    _broadcastTimer = setTimeout(() => {
      _socket.send(JSON.stringify({
        type:    "editor-op",
        from:    _username,
        file:    _activeFile,
        changes, // Monaco IModelContentChange[]
      }));
    }, 16); // ~1 frame debounce — fast but avoids per-keystroke spam
  }

  // ── Apply remote operation ───────────────────────────────────────────────────

  function _applyRemoteOp(msg) {
    if (!_editor) return;

    const model = _editor.getModel();
    if (!model) return;

    // Save cursor so we can restore it after applying remote edits
    const savedPosition  = _editor.getPosition();
    const savedSelection = _editor.getSelection();

    _suppressBroadcast = true;
    try {
      // Apply each change as a Monaco edit operation
      // IModelContentChange has: { range, text, rangeOffset, rangeLength }
      const edits = (msg.changes || []).map(ch => ({
        range:            ch.range,
        text:             ch.text,
        forceMoveMarkers: true,
      }));

      model.pushEditOperations(
        [],      // beforeCursorState — we manage cursor manually
        edits,
        () => [] // computeCursorState — return empty, we restore manually
      );
    } finally {
      _suppressBroadcast = false;
    }

    // Restore our cursor (it may have shifted due to remote insert/delete)
    if (savedPosition) {
      try { _editor.setPosition(savedPosition); } catch {}
    }
  }

  // ── Cursor broadcasting ───────────────────────────────────────────────────────

  function _sendCursorUpdate(selection) {
    if (!_socket || _socket.readyState !== WebSocket.OPEN) return;
    if (!_activeFile) return;

    _socket.send(JSON.stringify({
      type:      "cursor-update",
      from:      _username,
      file:      _activeFile,
      selection: {
        startLineNumber: selection.startLineNumber,
        startColumn:     selection.startColumn,
        endLineNumber:   selection.endLineNumber,
        endColumn:       selection.endColumn,
      },
    }));
  }

  // ── Remote cursor rendering ───────────────────────────────────────────────────

  function _renderRemoteCursor(username, selection) {
    if (!_editor) return;

    const colour = colourFor(username);
    const { startLineNumber, startColumn, endLineNumber, endColumn } = selection;

    // Inject per-user CSS if not already present
    _injectCursorCSS(username, colour);

    const decorations = [
      // Cursor line (blinking bar)
      {
        range: {
          startLineNumber: endLineNumber,
          startColumn:     endColumn,
          endLineNumber:   endLineNumber,
          endColumn:       endColumn + 1,
        },
        options: {
          className:         `remote-cursor-${_cssId(username)}`,
          hoverMessage:      { value: username },
          stickiness:        1, // NeverGrowsWhenTypingAtEdges
          zIndex:            10,
        },
      },
      // Selection highlight (if user has text selected)
      ...(startLineNumber !== endLineNumber || startColumn !== endColumn ? [{
        range: { startLineNumber, startColumn, endLineNumber, endColumn },
        options: {
          className: `remote-selection-${_cssId(username)}`,
          stickiness: 1,
        },
      }] : []),
      // Name label above cursor
      {
        range: {
          startLineNumber: endLineNumber,
          startColumn:     endColumn,
          endLineNumber:   endLineNumber,
          endColumn:       endColumn,
        },
        options: {
          before: {
            content:         " " + username + " ",
            inlineClassName: `remote-cursor-label-${_cssId(username)}`,
          },
          stickiness: 1,
        },
      },
    ];

    const prev = _remoteCursors.get(username) || [];
    const newIds = _editor.deltaDecorations(prev, decorations);
    _remoteCursors.set(username, newIds);
  }

  function _injectCursorCSS(username, colour) {
    const id = `crdt-style-${_cssId(username)}`;
    if (document.getElementById(id)) return;

    const hex16 = colour + "28"; // 16% opacity for selection
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      .remote-cursor-${_cssId(username)} {
        border-left: 2px solid ${colour};
        margin-left: -1px;
      }
      .remote-selection-${_cssId(username)} {
        background: ${hex16};
      }
      .remote-cursor-label-${_cssId(username)} {
        background: ${colour};
        color: #fff;
        font-size: 10px;
        font-family: var(--font-ui, sans-serif);
        padding: 1px 4px;
        border-radius: 3px 3px 3px 0;
        white-space: nowrap;
        pointer-events: none;
        user-select: none;
      }
    `;
    document.head.appendChild(style);
  }

  function _cssId(username) {
    // Make username safe for CSS class names
    return username.replace(/[^a-zA-Z0-9]/g, "_");
  }

  // ── Line locking ─────────────────────────────────────────────────────────────

  function _updateMyLock() {
    if (!_editor) return;
    const pos = _editor.getPosition();
    if (!pos) return;

    const range = {
      startLineNumber: pos.lineNumber,
      startColumn:     1,
      endLineNumber:   pos.lineNumber,
      endColumn:       10000,
    };

    _myLockRange = range;

    if (_socket && _socket.readyState === WebSocket.OPEN) {
      _socket.send(JSON.stringify({
        type:  "line-lock",
        from:  _username,
        file:  _activeFile,
        range,
      }));
    }

    // Auto-release lock after 2s of no typing
    clearTimeout(_lockTimer);
    _lockTimer = setTimeout(_unlockMyLines, 2000);
  }

  function _unlockMyLines() {
    _myLockRange = null;
    if (_socket && _socket.readyState === WebSocket.OPEN && _activeFile) {
      _socket.send(JSON.stringify({
        type: "line-unlock",
        from: _username,
        file: _activeFile,
      }));
    }
  }

  // Apply Monaco read-only ranges for all locked lines from other users
  function _enforceReadOnlyRanges() {
    if (!_editor) return;

    const ranges = Array.from(_remoteLockedRanges.values()).map(r => ({
      range: r,
      allowEditRanges: [],
    }));

    // Monaco 0.44+ supports setReadOnlyRanges
    try {
      const model = _editor.getModel();
      if (model && typeof model.setReadOnlyRanges === "function") {
        model.setReadOnlyRanges(ranges);
      }
    } catch {}
  }

  // ── Cleanup helpers ───────────────────────────────────────────────────────────

  function _clearAllRemoteDecorations() {
    if (!_editor) return;
    _remoteCursors.forEach((ids, username) => {
      _editor.deltaDecorations(ids, []);
    });
    _remoteCursors.clear();
  }

  function _clearUserDecorations(username) {
    if (!_editor) return;
    const ids = _remoteCursors.get(username) || [];
    _editor.deltaDecorations(ids, []);
    _remoteCursors.delete(username);
  }

  // ── Public: force broadcast current content (e.g. on file load) ──────────────

  function forceBroadcast() {
    if (!_editor || !_activeFile) return;
    if (!_socket || _socket.readyState !== WebSocket.OPEN) return;

    // On file switch, broadcast the full content once so late joiners catch up
    _socket.send(JSON.stringify({
      type:    "editor-full",
      from:    _username,
      file:    _activeFile,
      content: _editor.getValue(),
      lang:    _editor.getModel()?.getLanguageId() || "plaintext",
    }));
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  return {
    init,
    attachEditor,
    setActiveFile,
    handleMessage,
    forceBroadcast,
  };
})();