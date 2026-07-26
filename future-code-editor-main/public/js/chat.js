/**
 * chat.js v5
 *
 * FIXES vs v4:
 * - AIPanel.init() is now called at startup → AI button works
 * - aiToggleBtn is bound to AIPanel.toggle()
 * - exportZipBtn gated behind FileManager ready
 * - newFileBtn now opens the modal instead of prompt()
 * - LocalPathUI.init() called with project's saved path
 * - localPathBtn bound to LocalPathUI.open()
 * - Editor.bindEditorEvents() called after Monaco ready
 * - DM attach/call buttons shown when DM opened
 */

// ── Auth + project guard ──────────────────────────────────────────────────────
const username      = localStorage.getItem("chatUser");
const userEmail     = localStorage.getItem("chatEmail");
const activeProject = JSON.parse(sessionStorage.getItem("activeProject") || "null");

if (!username)      window.location.href = "index.html";
if (!activeProject) window.location.href = "dashboard.html";

const ROOM_ID  = activeProject.projectId;
const IS_ADMIN = activeProject.admin === username;

// ── Global state ──────────────────────────────────────────────────────────────
let socket        = null;
let allUsers      = [];
let contacts      = [];
let currentDMUser = null;
let activeChatTab = "room";

const userPresence    = new Map();
const peerConnections = new Map();
const dataChannels    = new Map();
let localStream       = null;
let currentCall       = null;
let callTimer         = null;
let callStartTime     = null;
let currentCallTarget = null;
let pendingOffer      = null;   // store the WebRTC offer SDP until user accepts/rejects
let isInCall          = false;  // guard against _initP2PForDM clobbering a call PC

let fileReceiveBuffer   = [];
let fileReceiveMetadata = null;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  _el("titlebarName").textContent   = username;
  _el("titlebarAvatar").textContent = UI.initial(username);
  _el("projectTitle").textContent   = activeProject.name;
  if (IS_ADMIN) _el("adminBadge")?.classList.remove("hidden");

  // Load project from DB (gets files with content)
  let project = activeProject;
  try {
    const data = await API.getProject(ROOM_ID, username);
    if (data.success) project = data.project;
  } catch {}

  // Init AI panel
  AIPanel.init();
  _el("aiToggleBtn")?.addEventListener("click", () => AIPanel.toggle());

  // Init local path UI
  LocalPathUI.init(ROOM_ID, username, project.localPath || null);
  _el("localPathBtn")?.addEventListener("click", () => LocalPathUI.open());

  // Show local path in sidebar if set
  if (project.localPath) {
    const bar = _el("localPathBar");
    const txt = _el("localPathDisplay");
    if (bar) bar.style.display = "flex";
    if (txt) txt.textContent = project.localPath;
  }

  // Init editor (Monaco) — will fire "monaco-ready"
  Editor.init(ROOM_ID, username);

  // Once Monaco is ready → init FileManager + bind editor events
  document.addEventListener("monaco-ready", () => {
    FileManager.init(
      ROOM_ID,
      username,
      IS_ADMIN,
      project.files || [],
      (file) => Editor.loadFile(file)
    );
    Editor.bindEditorEvents();
  }, { once: true });

  connectWebSocket();
  bindAllEvents();
  _loadContributions();
}

const _el = id => document.getElementById(id);

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(proto + "//" + location.host);

  socket.onopen = () => {
    _setConnected(true);
    socket.send(JSON.stringify({ type: "setName", name: username, email: userEmail, status: "online" }));
    socket.send(JSON.stringify({ type: "join",    room: ROOM_ID }));
    socket.send(JSON.stringify({ type: "get-contacts" }));
    CRDT.init(socket, ROOM_ID, username);
  };

  socket.onmessage = e => {
    try { _dispatch(JSON.parse(e.data)); }
    catch (err) { console.error("WS parse:", err); }
  };

  socket.onclose = () => { _setConnected(false); setTimeout(connectWebSocket, 3000); };
  socket.onerror = err => console.error("WS:", err);
}

function _dispatch(msg) {
  // CRDT messages
  if (["editor-op","editor-full","cursor-update","line-lock","line-unlock","file-switch"].includes(msg.type)) {
    CRDT.handleMessage(msg);
    if (msg.type === "file-switch" && msg.from && msg.file) {
      userPresence.set(msg.from, { file: msg.file });
      _renderPresence();
    }
    if (msg.type === "cursor-update" && msg.from) {
      const p = userPresence.get(msg.from) || {};
      p.line = msg.selection?.endLineNumber;
      userPresence.set(msg.from, p);
      _renderPresence();
    }
    return;
  }

  switch (msg.type) {
    case "userInfo":
      socket.send(JSON.stringify({ type: "get-contacts" }));
      break;
    case "allUsers":
      allUsers = msg.users;
      _renderCollaborators();
      _el("onlineBadge").textContent =
        allUsers.filter(u => u.username !== username && u.status !== "offline").length;
      break;
    case "joinedRoom":
      _el("currentRoomLabel").textContent = "# " + activeProject.name;
      _el("collabIndicator").innerHTML =
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="#4ec9b0" stroke="none"><circle cx="12" cy="12" r="10"/></svg> Collab';
      _enableRoomChat();
      break;
    case "chat":
      _addMsg("roomMessagesContainer", msg.data.from, msg.data.text, msg.data.timestamp, msg.data.from === username);
      break;
    case "online":  _renderProjectMembers(msg.users); break;
    case "system":  _addSysMsg(msg.message); break;
    case "typing":  _updateTyping("roomTypingIndicator", msg.users); break;
    case "contacts-list": contacts = msg.contacts; _renderContacts(); break;
    case "contact-added": socket.send(JSON.stringify({ type: "get-contacts" })); break;

    // DM
    case "dm":
      if (msg.from === currentDMUser) _addMsg("dmMessages", msg.from, msg.text, msg.timestamp, false);
      break;
    case "dm-sent":
      if (msg.to === currentDMUser) _addMsg("dmMessages", username, msg.text, msg.timestamp, true);
      break;
    case "dm-history":
      if (msg.with === currentDMUser) {
        _el("dmMessages").innerHTML = "";
        msg.messages.forEach(m => _addMsg("dmMessages", m.from, m.text, m.timestamp, m.from === username));
      }
      break;
    case "typing-dm":
      if (msg.from === currentDMUser) {
        const el = _el("dmTypingIndicator");
        if (el) el.textContent = msg.isTyping ? msg.from + " is typing…" : "";
      }
      break;

    // WebRTC
    case "webrtc-offer":  _handleOffer(msg.from, msg.data); break;
    case "webrtc-answer": _handleAnswer(msg.from, msg.data); break;
    case "webrtc-ice":    _handleICE(msg.from, msg.data); break;
    case "incoming-call": _showIncomingCall(msg.from, msg.callType); break;
    case "call-response": _handleCallResponse(msg.from, msg.accepted); break;
    case "call-ended":    endCall(); break;
    case "file-offer":    _handleFileOffer(msg.from, msg.fileName, msg.fileSize, msg.fileType); break;
    case "file-response": _handleFileResponse(msg.from, msg.accepted); break;
    case "error":         _addSysMsg("Error: " + msg.message); break;
  }
}

// ── Presence ──────────────────────────────────────────────────────────────────
function _renderPresence() {
  const list = _el("presenceList");
  if (!list) return;
  let html = "";
  userPresence.forEach((info, user) => {
    if (user === username) return;
    html += `<div class="presence-row">
      <div class="presence-avatar">${UI.initial(user)}</div>
      <div class="presence-info">
        <span class="presence-name">${UI.escape(user)}</span>
        <span class="presence-location">${info.file ? UI.escape(info.file) : "—"}${info.line ? " · Ln " + info.line : ""}</span>
      </div>
    </div>`;
  });
  list.innerHTML = html || '<div class="presence-empty">No collaborators yet</div>';
}

// ── Chat helpers ──────────────────────────────────────────────────────────────
function _enableRoomChat() {
  const inp = _el("roomMsgInput");
  const btn = _el("roomSendBtn");
  if (inp) { inp.disabled = false; inp.placeholder = "Message #" + activeProject.name + "…"; }
  if (btn)   btn.disabled = false;
}

function _sendRoomMsg() {
  const inp = _el("roomMsgInput");
  const text = inp?.value.trim();
  if (!text || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "chat", text }));
  inp.value = "";
}

function _addMsg(containerId, from, text, timestamp, isMine) {
  const c = _el(containerId);
  if (!c) return;
  c.querySelector(".chat-empty")?.remove();
  const el   = document.createElement("div");
  el.className = "message " + (isMine ? "my-message" : "");
  const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const av   = UI.initial(from);
  el.innerHTML =
    (!isMine ? `<div class="msg-avatar">${av}</div>` : "") +
    `<div class="message-content"><div class="message-bubble ${isMine ? "mine" : "other"}">${UI.escape(text)}</div>` +
    `<div class="message-meta">${!isMine ? `<span class="message-sender">${UI.escape(from)}</span>` : ""}<span>${time}</span></div></div>` +
    (isMine ? `<div class="msg-avatar">${av}</div>` : "");
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function _addSysMsg(text) {
  const id = activeChatTab === "dm" ? "dmMessages" : "roomMessagesContainer";
  const el = document.createElement("div");
  el.className = "system-message"; el.textContent = text;
  const c = _el(id);
  if (c) { c.appendChild(el); c.scrollTop = c.scrollHeight; }
}

function _updateTyping(elId, users) {
  const el = _el(elId);
  if (!el) return;
  const names = (users || []).filter(u => u !== username).slice(0, 3);
  el.textContent = names.length ? names.join(", ") + " typing…" : "";
}

// ── DM ────────────────────────────────────────────────────────────────────────
function _openDM(user) {
  currentDMUser = user;
  _el("dmPanelTitle").textContent = "@ " + user;

  // Show DM action buttons
  ["voiceCallBtn","videoCallBtn","attachBtnDM"].forEach(id => {
    const btn = _el(id);
    if (btn) btn.style.display = "flex";
  });

  _el("dmInput").disabled    = false;
  _el("dmSendBtn").disabled  = false;
  _el("dmInput").placeholder = "Message " + user + "…";
  _el("dmMessages").innerHTML = "";
  _switchChatTab("dm");

  document.querySelectorAll("#contactsList .collab-item").forEach(i =>
    i.classList.toggle("active", i.dataset.username === user));

  socket.send(JSON.stringify({ type: "load-dm", with: user }));
  _initP2PForDM(user);
}

function _sendDMMsg() {
  const inp  = _el("dmInput");
  const text = inp?.value.trim();
  if (!text || !currentDMUser || socket?.readyState !== WebSocket.OPEN) return;
  const ch = dataChannels.get(currentDMUser);
  if (ch?.readyState === "open") {
    ch.send(JSON.stringify({ type: "chat", text }));
    _addMsg("dmMessages", username, text, new Date(), true);
  } else {
    socket.send(JSON.stringify({ type: "dm", to: currentDMUser, text }));
  }
  inp.value = "";
}

function _switchChatTab(tab) {
  activeChatTab = tab;
  document.querySelectorAll(".chat-tab-btn").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".chat-tab-content").forEach(c => c.classList.remove("active"));
  _el(tab === "dm" ? "dmTabContent" : "roomTabContent")?.classList.add("active");
}

// ── UI ────────────────────────────────────────────────────────────────────────
function _setConnected(ok) {
  const pill  = _el("connectionPill");
  const label = _el("connLabel");
  if (label) label.textContent = ok ? "Connected" : "Disconnected";
  if (ok) pill?.classList.add("connected"); else pill?.classList.remove("connected");
}

function _renderCollaborators() {
  const list = _el("onlineUsers");
  if (!list) return;
  const online = allUsers.filter(u => u.username !== username && u.status !== "offline");
  list.innerHTML = online.map(u =>
    `<li class="collab-item" data-username="${UI.escape(u.username)}">
      <div class="collab-avatar ${u.status || "online"}">${UI.initial(u.username)}</div>
      <div><div class="collab-name">${UI.escape(u.username)}</div>
      <div class="collab-status">${u.status}</div></div></li>`
  ).join("");
  list.querySelectorAll(".collab-item").forEach(item => {
    item.addEventListener("click", () => { _addContact(item.dataset.username); _openDM(item.dataset.username); });
  });
}

function _renderContacts() {
  const list = _el("contactsList");
  if (!list) return;
  if (!contacts.length) { list.innerHTML = '<div class="no-contacts">No contacts yet</div>'; return; }
  list.innerHTML = contacts.map(c =>
    `<li class="collab-item ${currentDMUser === c.username ? "active" : ""}" data-username="${UI.escape(c.username)}">
      <div class="collab-avatar ${c.online ? c.status || "online" : "offline"}">${c.avatar}</div>
      <div><div class="collab-name">${UI.escape(c.username)}</div>
      <div class="collab-status">${c.online ? "Online" : "Offline"}</div></div></li>`
  ).join("");
  list.querySelectorAll(".collab-item").forEach(item => {
    item.addEventListener("click", () => _openDM(item.dataset.username));
  });
}

function _renderProjectMembers(users) {
  _el("roomUserCount").textContent = users.length;
  const list = _el("roomUsersList");
  if (!list) return;
  list.innerHTML = users.filter(u => u.username !== username).map(u =>
    `<li class="collab-item">
      <div class="collab-avatar online">${u.avatar}</div>
      <div class="collab-name">${UI.escape(u.username)}</div></li>`
  ).join("");
}

async function _loadContributions() {
  try {
    const res  = await API.getContributions(ROOM_ID);
    const list = _el("contributionList");
    if (!list || !res.success) return;
    if (!res.contributions?.length) { list.innerHTML = '<div class="no-contacts">No contributions yet</div>'; return; }
    list.innerHTML = res.contributions.map(c =>
      `<div class="contrib-row">
        <div class="contrib-avatar">${UI.initial(c.username)}</div>
        <div class="contrib-info">
          <span class="contrib-name">${UI.escape(c.username)}</span>
          <span class="contrib-stats">+${c.linesAdded||0} / -${c.linesRemoved||0} · ${c.edits||0} edits</span>
        </div></div>`
    ).join("");
  } catch {}
}

function _addContact(name) {
  if (name === username || contacts.find(c => c.username === name)) return;
  socket?.send(JSON.stringify({ type: "add-contact", username: name }));
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
async function _createPC(remoteUser) {
  peerConnections.get(remoteUser)?.close();
  peerConnections.delete(remoteUser);
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(remoteUser, pc);
  pc.onicecandidate = e => {
    if (e.candidate && socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "webrtc-ice", to: remoteUser, data: e.candidate }));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      peerConnections.delete(remoteUser);
      dataChannels.delete(remoteUser);
      isInCall = false;
    }
  };
  pc.ondatachannel = e => _setupDC(e.channel, remoteUser);
  pc.ontrack = e => {
    console.log("[WebRTC] ontrack fired, streams:", e.streams.length);
    const rv = _el("remoteVideo");
    if (rv) {
      rv.srcObject = e.streams[0];
      rv.play().catch(() => {});
    }
  };
  return pc;
}

function _setupDC(ch, remoteUser) {
  dataChannels.set(remoteUser, ch);
  ch.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === "chat" && currentDMUser === remoteUser) _addMsg("dmMessages", remoteUser, m.text, new Date(), false);
      else if (m.type === "file-chunk") _handleFileChunk(remoteUser, m);
    } catch {}
  };
}

// When we receive a WebRTC offer:
// - If it's a call scenario (currentCall is set or incoming-call was received),
//   just store the offer so acceptCall() can use it later.
// - Otherwise it's a P2P data-channel offer, answer immediately (no media).
async function _handleOffer(from, offer) {
  if (currentCall && currentCall.from === from) {
    // This is the call offer — store it; acceptCall() will handle negotiation
    pendingOffer = { from, offer };
    return;
  }
  // Normal data-channel offer (DM P2P)
  const pc = await _createPC(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.send(JSON.stringify({ type: "webrtc-answer", to: from, data: ans }));
}

async function _handleAnswer(from, ans) {
  const pc = peerConnections.get(from);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(ans));
    console.log("[WebRTC] Remote description set for", from);
  }
}

async function _handleICE(from, c) {
  const pc = peerConnections.get(from);
  if (!pc) {
    console.warn("[WebRTC] ICE candidate received but no PC for", from);
    return;
  }
  try {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } else {
      // Queue the ICE candidate until remote description is set
      if (!pc._queuedICE) pc._queuedICE = [];
      pc._queuedICE.push(c);
    }
  } catch (err) {
    console.error("[WebRTC] addIceCandidate error:", err);
  }
}

// Flush any ICE candidates that arrived before remote description was set
async function _flushICEQueue(pc) {
  if (pc._queuedICE && pc._queuedICE.length) {
    for (const c of pc._queuedICE) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    pc._queuedICE = [];
  }
}

async function _initP2PForDM(user) {
  // Don't clobber an active call's peer connection
  if (isInCall && peerConnections.has(user)) return;
  const pc = await _createPC(user);
  const ch = pc.createDataChannel("dm", { ordered: true });
  _setupDC(ch, user);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.send(JSON.stringify({ type: "webrtc-offer", to: user, data: offer }));
}

// ── Calls ─────────────────────────────────────────────────────────────────────
async function _initiateCall(to, callType) {
  currentCallTarget = to;
  isInCall = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: callType === "video", audio: true });
    const pc = await _createPC(to);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    // Show local preview
    const lv = _el("localVideo");
    if (lv) { lv.srcObject = localStream; lv.play().catch(() => {}); }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send signaling: first tell the remote about the call, then send the WebRTC offer
    socket.send(JSON.stringify({ type: "call-initiate",   to, callType }));
    socket.send(JSON.stringify({ type: "webrtc-offer",    to, data: offer }));

    _el("callUsername").textContent = to;
    _el("callStatus").textContent   = "Calling…";
    _el("callAvatar").textContent   = UI.initial(to);
    _el("videoCallModal").classList.remove("hidden");
    console.log("[Call] Initiated", callType, "call to", to);
  } catch (err) {
    console.error("[Call] getUserMedia failed:", err);
    isInCall = false;
    UI.toast("Camera/mic access denied", "error");
  }
}

function _showIncomingCall(from, callType) {
  _el("incomingCallUsername").textContent = from;
  _el("incomingCallType").textContent     = callType === "video" ? "Incoming Video Call" : "Incoming Voice Call";
  _el("incomingCallAvatar").textContent   = UI.initial(from);
  _el("incomingCallModal").classList.remove("hidden");
  currentCall = { from, callType };
  console.log("[Call] Incoming", callType, "call from", from);
}

async function acceptCall() {
  if (!currentCall) return;
  isInCall = true;
  const { from, callType } = currentCall;
  try {
    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({ video: callType === "video", audio: true });

    // Create a fresh PeerConnection and add our tracks
    const pc = await _createPC(from);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    // Show local preview
    const lv = _el("localVideo");
    if (lv) { lv.srcObject = localStream; lv.play().catch(() => {}); }

    // Apply the stored offer from the caller
    if (pendingOffer && pendingOffer.from === from) {
      await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.offer));
      await _flushICEQueue(pc);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.send(JSON.stringify({ type: "webrtc-answer", to: from, data: ans }));
      pendingOffer = null;
      console.log("[Call] Accepted, answer sent to", from);
    } else {
      console.warn("[Call] No pending offer from", from, "— creating new offer");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.send(JSON.stringify({ type: "webrtc-offer", to: from, data: offer }));
    }

    // Notify caller we accepted
    socket.send(JSON.stringify({ type: "call-response", to: from, accepted: true }));

    // Update UI
    _el("incomingCallModal").classList.add("hidden");
    _el("callUsername").textContent = from;
    _el("callStatus").textContent   = "Connected";
    _el("callAvatar").textContent   = UI.initial(from);
    _el("videoCallModal").classList.remove("hidden");
    _startCallTimer();
    currentCallTarget = from;
  } catch (err) {
    console.error("[Call] acceptCall failed:", err);
    isInCall = false;
    UI.toast("Camera/mic access denied", "error");
  }
}

function rejectCall() {
  if (!currentCall) return;
  socket.send(JSON.stringify({ type: "call-response", to: currentCall.from, accepted: false }));
  _el("incomingCallModal").classList.add("hidden");
  currentCall = null;
  pendingOffer = null;
  isInCall = false;
}

function _handleCallResponse(from, accepted) {
  if (accepted) {
    _el("callStatus").textContent = "Connected";
    _startCallTimer();
    console.log("[Call] Remote accepted");
  } else {
    endCall();
  }
}

function _startCallTimer() {
  callStartTime = Date.now();
  callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    _el("callDuration").textContent = String(Math.floor(s/60)).padStart(2,"0") + ":" + String(s%60).padStart(2,"0");
  }, 1000);
}

function endCall() {
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
  clearInterval(callTimer); callTimer = null;

  // Close the call's peer connection
  if (currentCallTarget) {
    const pc = peerConnections.get(currentCallTarget);
    if (pc) { pc.close(); peerConnections.delete(currentCallTarget); }
  }

  // Clear remote video
  const rv = _el("remoteVideo");
  if (rv) rv.srcObject = null;
  const lv = _el("localVideo");
  if (lv) lv.srcObject = null;

  _el("videoCallModal").classList.add("hidden");
  _el("incomingCallModal").classList.add("hidden");
  if (currentCallTarget && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "call-end", to: currentCallTarget }));
  currentCall = null; currentCallTarget = null;
  pendingOffer = null;
  isInCall = false;
  console.log("[Call] Ended");
}

function toggleMic() {
  const t = localStream?.getAudioTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    _el("toggleMicBtn").style.opacity = t.enabled ? "1" : "0.5";
    console.log("[Call] Mic", t.enabled ? "on" : "off");
  }
}
function toggleVideo() {
  const t = localStream?.getVideoTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    _el("toggleVideoBtn").style.opacity = t.enabled ? "1" : "0.5";
    console.log("[Call] Video", t.enabled ? "on" : "off");
  }
}

// ── P2P File transfer ─────────────────────────────────────────────────────────
async function _sendFileDM(targetUser) {
  const fi   = _el("fileInputDM");
  const file = fi?.files?.[0];
  if (!file || !targetUser) return;
  const ch = dataChannels.get(targetUser);
  if (!ch || ch.readyState !== "open") { UI.toast("P2P not ready. Send a text first.", "error"); return; }

  socket.send(JSON.stringify({ type: "file-offer", to: targetUser, fileName: file.name, fileSize: file.size, fileType: file.type }));
  _el("fileTransferModal").classList.remove("hidden");
  _el("transferFileName").textContent = file.name;
  _el("transferFileSize").textContent = UI.formatBytes(file.size);
  _el("transferStatus").textContent   = "Starting…";
  _el("transferProgress").style.width = "0%";

  await new Promise(r => setTimeout(r, 400));
  const CHUNK = 16384;
  let offset = 0, num = 0;
  const next = () => {
    if (offset >= file.size) {
      _el("transferStatus").textContent = "Complete!";
      setTimeout(() => { _el("fileTransferModal").classList.add("hidden"); if (fi) fi.value = ""; }, 1500);
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      if (ch.readyState === "open") {
        ch.send(JSON.stringify({ type: "file-chunk", fileName: file.name, chunk: Array.from(new Uint8Array(e.target.result)), offset, total: file.size, chunkNumber: num }));
        offset += e.target.result.byteLength; num++;
        const pct = (offset / file.size) * 100;
        _el("transferProgress").style.width = pct + "%";
        _el("transferStatus").textContent = "Transferring… " + Math.round(pct) + "%";
        setTimeout(next, 10);
      }
    };
    reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK));
  };
  next();
}

function _handleFileOffer(from, name, size, type) {
  const accept = confirm(`${from} wants to send: ${name} (${UI.formatBytes(size)})\n\nAccept?`);
  socket.send(JSON.stringify({ type: "file-response", to: from, accepted: accept }));
  if (accept) { fileReceiveBuffer = []; fileReceiveMetadata = { fileName: name, fileSize: size, fileType: type, from }; }
}
function _handleFileResponse(from, accepted) {
  if (!accepted) _el("fileTransferModal").classList.add("hidden");
}
function _handleFileChunk(from, msg) {
  fileReceiveBuffer.push(...msg.chunk);
  if (!fileReceiveMetadata) fileReceiveMetadata = { fileName: msg.fileName, fileSize: msg.total, fileType: "application/octet-stream", from };
  if (fileReceiveBuffer.length >= fileReceiveMetadata.fileSize) {
    const blob = new Blob([new Uint8Array(fileReceiveBuffer)], { type: fileReceiveMetadata.fileType });
    _addSysMsg("✅ File received: " + fileReceiveMetadata.fileName);
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement("a"), { href: url, download: fileReceiveMetadata.fileName });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Save file metadata to MongoDB (encrypted with AES-256)
    _saveFileMetaToDB(fileReceiveMetadata.from, fileReceiveMetadata.fileName, fileReceiveMetadata.fileSize, fileReceiveMetadata.fileType);

    fileReceiveBuffer = []; fileReceiveMetadata = null;
  }
}

/** Save file transfer metadata to MongoDB via /files/meta endpoint (AES-256 encrypted) */
async function _saveFileMetaToDB(sender, fileName, fileSize, fileType) {
  try {
    const encrypted = typeof Editor !== "undefined" ? await Editor.encrypt(fileName) : fileName;
    await fetch("/files/meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalName: encrypted,
        sender,
        receiver: username,
        size: fileSize,
        mimeType: fileType,
      }),
    });
    console.log("[FileMeta] Saved to DB:", fileName);
  } catch (err) {
    console.error("[FileMeta] Save failed:", err);
  }
}

// ── Bind all events ───────────────────────────────────────────────────────────
function bindAllEvents() {

  // Activity bar panel switching
  document.querySelectorAll(".activity-btn[data-panel]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".activity-btn[data-panel]").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".panel-section").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      _el(btn.dataset.panel + "Panel")?.classList.add("active");
    });
  });

  // Chat panel tabs
  document.querySelectorAll(".chat-tab-btn").forEach(t =>
    t.addEventListener("click", () => _switchChatTab(t.dataset.tab)));

  // Toggle chat panel
  _el("toggleChatBtn")?.addEventListener("click", () => {
    _el("chatPanel")?.classList.toggle("collapsed");
    Editor.layout();
  });

  // Navigation
  _el("backBtn")?.addEventListener("click",   () => { window.location.href = "dashboard.html"; });
  _el("logoutBtn")?.addEventListener("click", () => {
    if (confirm("Logout?")) { localStorage.removeItem("chatUser"); localStorage.removeItem("chatEmail"); socket?.close(); window.location.href = "index.html"; }
  });

  // Status
  _el("statusSelect")?.addEventListener("change", e =>
    socket?.send(JSON.stringify({ type: "status", status: e.target.value })));

  // Project chat send
  _el("roomSendBtn")?.addEventListener("click", _sendRoomMsg);
  _el("roomMsgInput")?.addEventListener("keypress", e => { if (e.key === "Enter") { e.preventDefault(); _sendRoomMsg(); } });

  // Typing
  let roomTypingTimer = null;
  _el("roomMsgInput")?.addEventListener("input", () => {
    socket?.send(JSON.stringify({ type: "typing", isTyping: true }));
    clearTimeout(roomTypingTimer);
    roomTypingTimer = setTimeout(() => socket?.send(JSON.stringify({ type: "typing", isTyping: false })), 1000);
  });

  // DM send
  _el("dmSendBtn")?.addEventListener("click", _sendDMMsg);
  _el("dmInput")?.addEventListener("keypress", e => { if (e.key === "Enter") { e.preventDefault(); _sendDMMsg(); } });

  let dmTypingTimer = null;
  _el("dmInput")?.addEventListener("input", () => {
    if (!currentDMUser) return;
    socket?.send(JSON.stringify({ type: "typing", isDM: true, to: currentDMUser, isTyping: true }));
    clearTimeout(dmTypingTimer);
    dmTypingTimer = setTimeout(() => socket?.send(JSON.stringify({ type: "typing", isDM: true, to: currentDMUser, isTyping: false })), 1000);
  });

  // DM file transfer
  _el("attachBtnDM")?.addEventListener("click", () => {
    if (!currentDMUser) { UI.toast("Open a DM first", "error"); return; }
    _el("fileInputDM")?.click();
  });
  _el("fileInputDM")?.addEventListener("change", () => { if (_el("fileInputDM").files.length > 0) _sendFileDM(currentDMUser); });
  _el("cancelTransferBtn")?.addEventListener("click", () => _el("fileTransferModal").classList.add("hidden"));

  // Call buttons
  _el("voiceCallBtn")?.addEventListener("click", () => { if (currentDMUser) _initiateCall(currentDMUser, "audio"); });
  _el("videoCallBtn")?.addEventListener("click", () => { if (currentDMUser) _initiateCall(currentDMUser, "video"); });
  _el("endCallBtn")?.addEventListener("click",    endCall);
  _el("toggleMicBtn")?.addEventListener("click",  toggleMic);
  _el("toggleVideoBtn")?.addEventListener("click",toggleVideo);
  _el("acceptCallBtn")?.addEventListener("click", acceptCall);
  _el("rejectCallBtn")?.addEventListener("click", rejectCall);

  // Contacts
  _el("addContactBtn")?.addEventListener("click", () => {
    const name = prompt("Username to add:");
    if (name?.trim()) _addContact(name.trim());
  });

  // Invite member (admin only)
  _el("inviteMemberBtn")?.addEventListener("click", async () => {
    if (!IS_ADMIN) { UI.toast("Only admin can invite members", "error"); return; }
    const target = prompt("Username to invite:");
    if (!target?.trim()) return;
    const res = await API.inviteMember(ROOM_ID, username, target.trim());
    UI.toast(res.success ? "Invited " + target : (res.message || "Failed"), res.success ? "success" : "error");
  });

  // Clear chat — clears the active tab's messages
  _el("clearChatBtn")?.addEventListener("click", () => {
    if (!confirm("Clear messages?")) return;
    const targetId = activeChatTab === "dm" ? "dmMessages" : "roomMessagesContainer";
    const el = _el(targetId);
    if (el) el.innerHTML = "";
  });

  // Contributions refresh
  _el("refreshContribBtn")?.addEventListener("click", _loadContributions);

  // Emoji picker — targets room or DM input based on active tab
  const emojis = ["😀","😃","😄","😅","😂","🤣","😊","😇","😉","😍","😎","🤩","🥳","👍","👎","👏","🙌","✌️","👌","👋","💪","🙏","❤️","🔥","✨","⭐","✅","❌","🎉","📁","📄","📹","📞","🐛","🔧","⚙️","🚀","💡","🎯","📦"];
  const grid = document.querySelector(".emoji-grid");
  if (grid) {
    emojis.forEach(em => {
      const s = document.createElement("span");
      s.textContent = em;
      s.addEventListener("click", () => {
        const inp = _el(activeChatTab === "dm" ? "dmInput" : "roomMsgInput");
        if (inp) { inp.value += em; inp.focus(); }
        _el("emojiPicker")?.classList.add("hidden");
      });
      grid.appendChild(s);
    });
  }
  _el("emojiBtn")?.addEventListener("click", e => {
    e.stopPropagation();
    _el("emojiPicker")?.classList.toggle("hidden");
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#emojiBtn") && !e.target.closest("#emojiPicker"))
      _el("emojiPicker")?.classList.add("hidden");
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();