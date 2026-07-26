/**
 * api.js v4
 * All fetch() calls in one place.
 * Added: AI chat, local path validation/save, project path update.
 */

const API = {

  // ── Auth ───────────────────────────────────────────────────────────────────

  async getConfig() {
    const res = await fetch("/config");
    if (!res.ok) throw new Error("Config fetch failed");
    return res.json();
  },

  async verifyClerkSession(sessionToken) {
    const res = await fetch("/verify-clerk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken }),
    });
    return res.json();
  },

  // ── Projects ───────────────────────────────────────────────────────────────

  async getProjects(username) {
    const res = await fetch("/projects?username=" + encodeURIComponent(username));
    return res.json();
  },

  async createProject(username, name, members = []) {
    const res = await fetch("/projects/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, name, members }),
    });
    return res.json();
  },

  async getProject(projectId, username) {
    const res = await fetch(`/projects/${projectId}?username=` + encodeURIComponent(username));
    return res.json();
  },

  async deleteProject(projectId, username) {
    const res = await fetch(`/projects/${projectId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return res.json();
  },

  async updateProjectPath(projectId, username, localPath) {
    const res = await fetch(`/projects/${projectId}/path`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, localPath }),
    });
    return res.json();
  },

  // ── Invitations ────────────────────────────────────────────────────────────

  async inviteMember(projectId, adminUsername, targetUsername) {
    const res = await fetch(`/projects/${projectId}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: adminUsername, targetUsername }),
    });
    return res.json();
  },

  async acceptInvitation(projectId, username) {
    const res = await fetch(`/projects/${projectId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return res.json();
  },

  async declineInvitation(projectId, username) {
    const res = await fetch(`/projects/${projectId}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    return res.json();
  },

  // ── Files ──────────────────────────────────────────────────────────────────

  async createFile(projectId, username, filename) {
    const res = await fetch(`/projects/${projectId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, filename }),
    });
    return res.json();
  },

  // FIX: use encodeURIComponent for filename, backend decodes it
  async saveFile(projectId, username, filename, content) {
    const res = await fetch(
      `/projects/${projectId}/files/${encodeURIComponent(filename)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, content }),
      }
    );
    return res.json();
  },

  async approveFile(projectId, adminUsername, filename) {
    const res = await fetch(
      `/projects/${projectId}/files/${encodeURIComponent(filename)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: adminUsername }),
      }
    );
    return res.json();
  },

  async rejectFile(projectId, adminUsername, filename) {
    const res = await fetch(
      `/projects/${projectId}/files/${encodeURIComponent(filename)}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: adminUsername }),
      }
    );
    return res.json();
  },

  async getContributions(projectId) {
    const res = await fetch(`/projects/${projectId}/contributions`);
    return res.json();
  },

  // ── File upload (P2P backup) ───────────────────────────────────────────────

  async uploadFile(blob, fileName, sender, receiver) {
    const form = new FormData();
    form.append("file", blob, fileName);
    form.append("sender", sender);
    form.append("receiver", receiver);
    const res = await fetch("/upload", { method: "POST", body: form });
    return res.json();
  },

  // ── AI ─────────────────────────────────────────────────────────────────────

  async askAI(message, context = null, history = []) {
    const res = await fetch("/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context, history }),
    });
    return res.json();
  },

  // ── Local filesystem ────────────────────────────────────────────────────────

  async validatePath(inputPath) {
    const res = await fetch("/local/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: inputPath }),
    });
    return res.json();
  },

  async saveToPath(inputPath, files) {
    const res = await fetch("/local/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: inputPath, files }),
    });
    return res.json();
  },

  async mkdirPath(inputPath) {
    const res = await fetch("/local/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: inputPath }),
    });
    return res.json();
  },

  async getDirectoryTree(inputPath, depth = 2) {
    const res = await fetch(
      `/local/tree?path=${encodeURIComponent(inputPath)}&depth=${depth}`
    );
    return res.json();
  },

};