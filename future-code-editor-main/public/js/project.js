/**
 * project.js — Project state management layer.
 * Wraps API calls with local state cache.
 * Used by dashboard.js and chat.js.
 * Depends on: api.js
 */

const ProjectManager = (() => {

  let _projects    = [];   // cached list
  let _currentUser = null;

  /** Call once at page load */
  function init(username) {
    _currentUser = username;
  }

  /** Fetch all projects for the current user from the server */
  async function loadAll() {
    const data = await API.getProjects(_currentUser);
    if (data.success) _projects = data.projects;
    return _projects;
  }

  /** Get cached list */
  function getAll() { return _projects; }

  /** Get a single project by id from cache */
  function getById(id) {
    return _projects.find(p => p.projectId === id) || null;
  }

  /**
   * Create a new project.
   * @param {string} name
   * @param {string[]} members - usernames to invite
   * @returns {Object} created project
   */
  async function create(name, members = []) {
    const data = await API.createProject(_currentUser, name, members);
    if (data.success) {
      _projects.push(data.project);
      return data.project;
    }
    throw new Error(data.message || "Failed to create project");
  }

  /** Delete a project (admin only) */
  async function remove(projectId) {
    const data = await API.deleteProject(projectId, _currentUser);
    if (data.success) {
      _projects = _projects.filter(p => p.projectId !== projectId);
    }
    return data;
  }

  /** Accept a project invitation */
  async function acceptInvite(projectId) {
    const data = await API.acceptInvitation(projectId, _currentUser);
    if (data.success) {
      // Move from invitedUsers → members locally
      const p = _projects.find(p => p.projectId === projectId);
      if (p) {
        p.invitedUsers = (p.invitedUsers || []).filter(u => u !== _currentUser);
        if (!p.members.includes(_currentUser)) p.members.push(_currentUser);
      }
    }
    return data;
  }

  /** Decline an invitation */
  async function declineInvite(projectId) {
    const data = await API.declineInvitation(projectId, _currentUser);
    if (data.success) {
      _projects = _projects.filter(p => p.projectId !== projectId);
    }
    return data;
  }

  /** Invite another user (admin only) */
  async function invite(projectId, targetUsername) {
    return API.inviteMember(projectId, _currentUser, targetUsername);
  }

  /** Check if current user is admin of a project */
  function isAdmin(project) {
    return project && project.admin === _currentUser;
  }

  /** Split projects into accepted vs pending invitations */
  function splitProjects() {
    const accepted = _projects.filter(p => p.members.includes(_currentUser));
    const invited  = _projects.filter(p =>
      (p.invitedUsers || []).includes(_currentUser) && !p.members.includes(_currentUser)
    );
    return { accepted, invited };
  }

  return { init, loadAll, getAll, getById, create, remove, acceptInvite, declineInvite, invite, isAdmin, splitProjects };
})();