/**
 * dashboard.js — Dashboard page logic.
 * Manages: projects list, invitations, "Chat with Friends" DM panel, create modal.
 * Depends on: api.js, ui.js, project.js
 */

// ── Auth guard ────────────────────────────────────────────────────────────────

const currentUser  = localStorage.getItem("chatUser");
const currentEmail = localStorage.getItem("chatEmail");
if (!currentUser) window.location.href = "index.html";

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────────

let wsSocket         = null;
let allOnlineUsers   = [];
let selectedInvitees = new Set();
let activeSideSection = "projects";  // "projects" | "friends" | "create"

// DM state (moved from chat page)
let dmCurrentUser    = null;
let dmContacts       = [];
let dmTypingTimer    = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  $("dashUsername").textContent = currentUser;
  $("dashAvatar").textContent   = UI.initial(currentUser);

  ProjectManager.init(currentUser);
  connectWebSocket();
  bindSidebar();
  bindModal();
  bindDM();
  bindLogout();

  await loadProjects();
  showSection("projects");
}

// ── Load and render projects ──────────────────────────────────────────────────

async function loadProjects() {
  try {
    await ProjectManager.loadAll();
    renderProjectSection();
  } catch (err) {
    console.error("Load projects error:", err);
    UI.toast("Failed to load projects", "error");
  }
}

function renderProjectSection() {
  const { accepted, invited } = ProjectManager.splitProjects();

  renderInvitations(invited);
  renderProjectGrid(accepted);
}

function renderProjectGrid(projects) {
  const grid  = $("projectGrid");
  const empty = $("emptyState");

  if (projects.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  grid.innerHTML = projects.map(p => `
    <div class="project-card" data-id="${UI.escape(p.projectId)}">
      <div class="project-card-header">
        <div class="project-icon">${UI.initial(p.name)}</div>
        <div class="project-meta">
          <h3 class="project-name">${UI.escape(p.name)}</h3>
          <p class="project-date">${formatDate(p.createdAt)}</p>
          ${p.admin === currentUser ? '<span class="admin-badge">Admin</span>' : ""}
        </div>
        ${p.admin === currentUser ? `
          <button class="project-delete" data-id="${UI.escape(p.projectId)}" title="Delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>` : ""}
      </div>
      <div class="project-members">
        ${(p.members || []).slice(0, 6).map(m =>
          `<div class="member-pip" title="${UI.escape(m)}">${UI.initial(m)}</div>`
        ).join("")}
        ${(p.members || []).length > 6 ? `<div class="member-pip member-pip-more">+${p.members.length - 6}</div>` : ""}
      </div>
      <div class="project-footer">
        <span class="member-count-label">
          ${p.members.length} member${p.members.length !== 1 ? "s" : ""}
        </span>
        <button class="open-btn" data-id="${UI.escape(p.projectId)}">Open →</button>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".open-btn").forEach(btn => {
    btn.addEventListener("click", () => openProject(btn.dataset.id));
  });
  grid.querySelectorAll(".project-card").forEach(card => {
    card.addEventListener("dblclick", () => openProject(card.dataset.id));
  });
  grid.querySelectorAll(".project-delete").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); deleteProject(btn.dataset.id); });
  });
}

function renderInvitations(invited) {
  const container = $("invitationList");
  const section   = $("invitationSection");
  if (!container || !section) return;

  if (invited.length === 0) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");

  container.innerHTML = invited.map(p => `
    <div class="invitation-card" data-id="${UI.escape(p.projectId)}">
      <div class="inv-icon">${UI.initial(p.name)}</div>
      <div class="inv-info">
        <strong>${UI.escape(p.name)}</strong>
        <span>Invited by ${UI.escape(p.admin)}</span>
      </div>
      <div class="inv-actions">
        <button class="inv-accept" data-id="${UI.escape(p.projectId)}">Accept</button>
        <button class="inv-decline" data-id="${UI.escape(p.projectId)}">Decline</button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".inv-accept").forEach(btn => {
    btn.addEventListener("click", async () => {
      const res = await ProjectManager.acceptInvite(btn.dataset.id);
      if (res.success) { UI.toast("Joined project!", "success"); renderProjectSection(); }
      else UI.toast("Failed to accept", "error");
    });
  });

  container.querySelectorAll(".inv-decline").forEach(btn => {
    btn.addEventListener("click", async () => {
      await ProjectManager.declineInvite(btn.dataset.id);
      UI.toast("Invitation declined", "info");
      renderProjectSection();
    });
  });
}

function openProject(projectId) {
  const project = ProjectManager.getById(projectId);
  if (!project) return;
  sessionStorage.setItem("activeProject", JSON.stringify(project));
  window.location.href = "chat.html";
}

async function deleteProject(projectId) {
  if (!confirm("Delete this project? This cannot be undone.")) return;
  const res = await ProjectManager.remove(projectId);
  if (res.success) { UI.toast("Project deleted", "info"); renderProjectSection(); }
  else UI.toast(res.message || "Delete failed", "error");
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}

// ── Sidebar navigation ────────────────────────────────────────────────────────

function showSection(section) {
  activeSideSection = section;

  // Highlight active sidebar item
  document.querySelectorAll(".sidebar-nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.section === section);
  });

  // Show/hide content areas
  const sections = ["projects-content", "friends-content"];
  sections.forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle("hidden", !id.startsWith(section));
  });

  // Open create modal if section is "create"
  if (section === "create") {
    openCreateModal();
    // Reset active to "projects" so sidebar doesn't stay on "create"
    showSection("projects");
  }
}

function bindSidebar() {
  document.querySelectorAll(".sidebar-nav-item").forEach(item => {
    item.addEventListener("click", () => showSection(item.dataset.section));
  });
}

// ── Create project modal ──────────────────────────────────────────────────────

function openCreateModal() {
  selectedInvitees.clear();
  $("projectName").value   = "";
  $("memberSearch").value  = "";
  $("selectedTags").innerHTML = "";
  renderMemberPickerList("");
  $("createModal").classList.remove("hidden");
  $("modalOverlay").classList.remove("hidden");
  setTimeout(() => $("projectName")?.focus(), 50);
}

function closeCreateModal() {
  $("createModal").classList.add("hidden");
  $("modalOverlay").classList.add("hidden");
}

function renderMemberPickerList(filter) {
  const query = filter.toLowerCase();
  const users = allOnlineUsers.filter(u =>
    u.username !== currentUser && u.username.toLowerCase().includes(query)
  );
  const list = $("memberList");
  if (!list) return;

  list.innerHTML = users.length === 0
    ? `<p class="member-list-empty">No users found${query ? ' for "' + UI.escape(filter) + '"' : "."}</p>`
    : users.map(u => `
        <div class="member-row ${selectedInvitees.has(u.username) ? "selected" : ""}"
             data-username="${UI.escape(u.username)}">
          <div class="member-row-avatar ${u.status || "online"}">${UI.initial(u.username)}</div>
          <div class="member-row-info">
            <span class="member-row-name">${UI.escape(u.username)}</span>
            <span class="member-row-status">${u.status || "online"}</span>
          </div>
          <div class="member-row-check">${selectedInvitees.has(u.username) ? "✓" : ""}</div>
        </div>
      `).join("");

  list.querySelectorAll(".member-row").forEach(row => {
    row.addEventListener("click", () => toggleInvitee(row.dataset.username));
  });
}

function toggleInvitee(username) {
  if (selectedInvitees.has(username)) selectedInvitees.delete(username);
  else selectedInvitees.add(username);
  renderSelectedTags();
  renderMemberPickerList($("memberSearch").value.trim());
}

function renderSelectedTags() {
  const tags = $("selectedTags");
  if (!tags) return;
  tags.innerHTML = [...selectedInvitees].map(m => `
    <span class="member-tag">
      ${UI.escape(m)}
      <button class="tag-remove" data-username="${UI.escape(m)}">×</button>
    </span>
  `).join("");
  tags.querySelectorAll(".tag-remove").forEach(btn => {
    btn.addEventListener("click", () => { selectedInvitees.delete(btn.dataset.username); renderSelectedTags(); renderMemberPickerList($("memberSearch").value.trim()); });
  });
}

async function submitCreateProject() {
  const name = $("projectName").value.trim();
  if (!name) { UI.toast("Enter a project name", "error"); $("projectName").focus(); return; }

  try {
    const project = await ProjectManager.create(name, [...selectedInvitees]);
    closeCreateModal();
    renderProjectSection();
    UI.toast('"' + project.name + '" created!', "success");
  } catch (err) {
    UI.toast(err.message || "Failed to create project", "error");
  }
}

function bindModal() {
  $("createProjectBtn")?.addEventListener("click", openCreateModal);
  $("modalClose")?.addEventListener("click", closeCreateModal);
  $("modalOverlay")?.addEventListener("click", closeCreateModal);
  $("cancelCreate")?.addEventListener("click", closeCreateModal);
  $("confirmCreate")?.addEventListener("click", submitCreateProject);
  $("projectName")?.addEventListener("keypress", e => { if (e.key === "Enter") submitCreateProject(); });
  $("memberSearch")?.addEventListener("input", e => renderMemberPickerList(e.target.value.trim()));
}

// ── DM (Chat with Friends) ────────────────────────────────────────────────────

function bindDM() {
  $("dmSendBtn")?.addEventListener("click", sendDMMessage);
  $("dmInput")?.addEventListener("keypress", e => {
    if (e.key === "Enter") { e.preventDefault(); sendDMMessage(); }
  });
  $("dmInput")?.addEventListener("input", () => {
    if (!wsSocket || !dmCurrentUser) return;
    wsSocket.send(JSON.stringify({ type: "typing", isDM: true, to: dmCurrentUser, isTyping: true }));
    clearTimeout(dmTypingTimer);
    dmTypingTimer = setTimeout(() => {
      wsSocket?.send(JSON.stringify({ type: "typing", isDM: true, to: dmCurrentUser, isTyping: false }));
    }, 1000);
  });
}

function openDM(username) {
  dmCurrentUser = username;
  $("friendsChatTitle").textContent = "@ " + username;
  $("dmInput").disabled    = false;
  $("dmSendBtn").disabled  = false;
  $("dmMessages").innerHTML = "";

  // Highlight active contact
  document.querySelectorAll(".friend-item").forEach(i =>
    i.classList.toggle("active", i.dataset.username === username));

  // Load DM history
  wsSocket?.send(JSON.stringify({ type: "load-dm", with: username }));
}

function sendDMMessage() {
  const input = $("dmInput");
  const text  = input.value.trim();
  if (!text || !dmCurrentUser || !wsSocket || wsSocket.readyState !== WebSocket.OPEN) return;
  wsSocket.send(JSON.stringify({ type: "dm", to: dmCurrentUser, text }));
  input.value = "";
}

function renderContactsList() {
  const list = $("friendsList");
  if (!list) return;

  const items = [...dmContacts, ...allOnlineUsers.filter(u =>
    u.username !== currentUser && !dmContacts.find(c => c.username === u.username)
  )];

  list.innerHTML = items.map(u => `
    <div class="friend-item ${dmCurrentUser === u.username ? "active" : ""}"
         data-username="${UI.escape(u.username)}">
      <div class="friend-avatar ${u.status || "offline"}">${UI.initial(u.username)}</div>
      <div class="friend-name">${UI.escape(u.username)}</div>
    </div>
  `).join("");

  list.querySelectorAll(".friend-item").forEach(item => {
    item.addEventListener("click", () => openDM(item.dataset.username));
  });
}

function addDMMessage(from, text, timestamp, isMine) {
  const container = $("dmMessages");
  if (!container) return;
  container.querySelector(".chat-empty")?.remove();
  const el = document.createElement("div");
  el.className = "message " + (isMine ? "my-message" : "");
  const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML =
    (!isMine ? `<div class="msg-avatar">${UI.initial(from)}</div>` : "") +
    `<div class="message-content"><div class="message-bubble ${isMine ? "mine" : "other"}">${UI.escape(text)}</div>` +
    `<div class="message-meta">${!isMine ? `<span class="message-sender">${UI.escape(from)}</span>` : ""}<span>${time}</span></div></div>` +
    (isMine ? `<div class="msg-avatar">${UI.initial(from)}</div>` : "");
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  wsSocket = new WebSocket(proto + "//" + location.host);

  wsSocket.onopen = () => {
    wsSocket.send(JSON.stringify({ type: "setName", name: currentUser, email: currentEmail, status: "online" }));
    wsSocket.send(JSON.stringify({ type: "get-contacts" }));
  };

  wsSocket.onmessage = e => {
    try { handleWSMessage(JSON.parse(e.data)); } catch {}
  };

  wsSocket.onclose = () => setTimeout(connectWebSocket, 3000);
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case "allUsers":
      allOnlineUsers = msg.users.filter(u => u.username !== currentUser);
      renderContactsList();
      renderMemberPickerList($("memberSearch")?.value.trim() || "");
      break;

    case "contacts-list":
      dmContacts = msg.contacts;
      renderContactsList();
      break;

    case "dm":
      if (msg.from === dmCurrentUser) addDMMessage(msg.from, msg.text, msg.timestamp, false);
      break;

    case "dm-sent":
      if (msg.to === dmCurrentUser) addDMMessage(currentUser, msg.text, msg.timestamp, true);
      break;

    case "dm-history":
      if (msg.with === dmCurrentUser) {
        $("dmMessages").innerHTML = "";
        msg.messages.forEach(m => addDMMessage(m.from, m.text, m.timestamp, m.from === currentUser));
      }
      break;

    case "typing-dm":
      if (msg.from === dmCurrentUser) {
        const el = $("dmTyping");
        if (el) el.textContent = msg.isTyping ? msg.from + " is typing..." : "";
      }
      break;
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────

function bindLogout() {
  $("logoutBtn")?.addEventListener("click", () => {
    if (confirm("Logout?")) {
      localStorage.removeItem("chatUser");
      localStorage.removeItem("chatEmail");
      wsSocket?.close();
      window.location.href = "index.html";
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
