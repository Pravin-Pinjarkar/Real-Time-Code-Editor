/**
 * routes/projects.js (v5)
 *
 * CRITICAL FIX for "code not saving to DB":
 * After mutating file.content (a subdocument field), you MUST call
 *   project.markModified("files")
 * before project.save(). Without this, Mongoose doesn't detect the change
 * and skips the DB write entirely — data appears to save (no error) but
 * nothing is actually written. This was the root cause.
 */

const express = require("express");
const router  = express.Router();
const Project = require("../models/projectModel");
const { v4: uuidv4 } = require("uuid");

function langFromExt(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  return {
    js:"javascript", ts:"typescript", py:"python",
    html:"html", css:"css", json:"json",
    cpp:"cpp", c:"c", java:"java",
    rs:"rust", go:"go", md:"markdown", sql:"sql",
    rb:"ruby", php:"php", swift:"swift", kt:"kotlin",
    cs:"csharp", sh:"shell",
  }[ext] || "plaintext";
}

function countLines(text) { return (text || "").split("\n").length; }

function sanitize(doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.__v;
  return obj;
}

// ── POST /projects/create ─────────────────────────────────────────────────────
router.post("/create", async (req, res) => {
  try {
    const { username, name, members = [], localPath } = req.body;
    if (!username || !name) return res.status(400).json({ success: false, message: "username and name required" });

    const project = new Project({
      projectId:    uuidv4(),
      name,
      admin:        username,
      members:      [...new Set([username, ...members])],
      invitedUsers: members.filter(m => m !== username),
      localPath:    localPath || null,
    });

    await project.save();
    return res.json({ success: true, project: sanitize(project) });
  } catch (err) {
    console.error("Create project:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── GET /projects ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: "username required" });
    const projects = await Project.find({ $or: [{ members: username }, { invitedUsers: username }] })
      .select("-chatHistory -files.pendingContent");
    return res.json({ success: true, projects: projects.map(sanitize) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /projects/:projectId ──────────────────────────────────────────────────
// Returns FULL project including file.content for editor hydration
router.get("/:projectId", async (req, res) => {
  try {
    const { username } = req.query;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (!project.members.includes(username) && !project.invitedUsers.includes(username))
      return res.status(403).json({ success: false, message: "Access denied" });
    return res.json({ success: true, project: sanitize(project) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /projects/:projectId/files — create new file ────────────────────────
router.post("/:projectId/files", async (req, res) => {
  try {
    const { username, filename } = req.body;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (!project.members.includes(username)) return res.status(403).json({ success: false, message: "Access denied" });

    if (project.files.find(f => f.name === filename))
      return res.json({ success: false, message: "File already exists" });

    project.files.push({ name: filename, language: langFromExt(filename), content: "", createdBy: username });
    project.markModified("files");  // ← required for subdocument arrays
    await project.save();

    const file = project.files.find(f => f.name === filename);
    return res.json({ success: true, file });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /save — SAVE CODE (Direct API) ──────────────────────────────────────
router.post("/save", async (req, res) => {
  try {
    const { projectId, filename, code } = req.body;
    
    if (!projectId || !filename) {
      return res.status(400).json({ success: false, message: "projectId and filename required" });
    }

    const project = await Project.findOne({ projectId });
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    const file = project.files.find(f => f.name === filename);
    if (!file) return res.status(404).json({ success: false, message: "File not found" });

    // Update file content inside project schema
    file.content = code || "";
    file.updatedAt = new Date();

    project.markModified("files");
    await project.save();

    return res.json({ success: true, message: "Code saved successfully" });
  } catch (err) {
    console.error("Direct Save file error:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── PUT /projects/:projectId/files/:filename — SAVE CODE ─────────────────────
router.put("/:projectId/files/:filename", async (req, res) => {
  try {
    const { username, content } = req.body;
    const filename = decodeURIComponent(req.params.filename);

    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (!project.members.includes(username)) return res.status(403).json({ success: false, message: "Access denied" });

    const file = project.files.find(f => f.name === filename);
    if (!file) return res.status(404).json({ success: false, message: "File not found in project" });

    // Ensure content is a string
    const safeContent = typeof content === "string" ? content : "";

    const prevLines = countLines(file.content);
    const newLines  = countLines(safeContent);

    if (project.admin === username) {
      // Admin → save directly
      file.content        = safeContent;
      file.updatedBy      = username;
      file.updatedAt      = new Date();
      file.pendingContent = null;
      file.pendingBy      = null;

      project.trackContribution(username, Math.max(0, newLines - prevLines), Math.max(0, prevLines - newLines));
      project.markModified("files");   // ← THE CRITICAL FIX
      await project.save();

      console.log(`💾 Saved "${filename}" (${safeContent.length} chars) → ${project.name}`);
      return res.json({ success: true, status: "saved" });
    } else {
      // Non-admin → submit for approval
      file.pendingContent = safeContent;
      file.pendingBy      = username;
      project.markModified("files");   // ← also needed here
      await project.save();
      return res.json({ success: true, status: "pending_approval" });
    }
  } catch (err) {
    console.error("Save file:", err);
    return res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ── POST /projects/:projectId/files/:filename/approve ─────────────────────────
router.post("/:projectId/files/:filename/approve", async (req, res) => {
  try {
    const { username } = req.body;
    const filename     = decodeURIComponent(req.params.filename);
    const project      = await Project.findOne({ projectId: req.params.projectId });

    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (project.admin !== username) return res.status(403).json({ success: false, message: "Admin only" });

    const file = project.files.find(f => f.name === filename);
    if (!file?.pendingContent) return res.status(400).json({ success: false, message: "No pending change" });

    const prevLines = countLines(file.content);
    const newLines  = countLines(file.pendingContent);
    project.trackContribution(file.pendingBy, Math.max(0, newLines - prevLines), Math.max(0, prevLines - newLines));

    file.content        = file.pendingContent;
    file.updatedBy      = file.pendingBy;
    file.updatedAt      = new Date();
    file.pendingContent = null;
    file.pendingBy      = null;

    project.markModified("files");
    await project.save();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /projects/:projectId/files/:filename/reject ──────────────────────────
router.post("/:projectId/files/:filename/reject", async (req, res) => {
  try {
    const { username } = req.body;
    const filename     = decodeURIComponent(req.params.filename);
    const project      = await Project.findOne({ projectId: req.params.projectId });
    if (!project || project.admin !== username) return res.status(403).json({ success: false, message: "Admin only" });

    const file = project.files.find(f => f.name === filename);
    if (file) { file.pendingContent = null; file.pendingBy = null; }
    project.markModified("files");
    await project.save();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /projects/:projectId/invite ─────────────────────────────────────────
router.post("/:projectId/invite", async (req, res) => {
  try {
    const { username, targetUsername } = req.body;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (project.admin !== username) return res.status(403).json({ success: false, message: "Admin only" });
    if (project.members.includes(targetUsername) || project.invitedUsers.includes(targetUsername))
      return res.json({ success: false, message: "Already a member or invited" });
    project.invitedUsers.push(targetUsername);
    await project.save();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ── POST /projects/:projectId/accept ─────────────────────────────────────────
router.post("/:projectId/accept", async (req, res) => {
  try {
    const { username } = req.body;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    project.invitedUsers = project.invitedUsers.filter(u => u !== username);
    if (!project.members.includes(username)) project.members.push(username);
    await project.save();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ── POST /projects/:projectId/decline ────────────────────────────────────────
router.post("/:projectId/decline", async (req, res) => {
  try {
    const { username } = req.body;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    project.invitedUsers = project.invitedUsers.filter(u => u !== username);
    await project.save();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ── PATCH /projects/:projectId/path ──────────────────────────────────────────
router.patch("/:projectId/path", async (req, res) => {
  try {
    const { username, localPath } = req.body;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (!project.members.includes(username)) return res.status(403).json({ success: false, message: "Access denied" });
    project.localPath = localPath || null;
    await project.save();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ── GET /projects/:projectId/contributions ────────────────────────────────────
router.get("/:projectId/contributions", async (req, res) => {
  try {
    const project = await Project.findOne({ projectId: req.params.projectId }).select("contributions");
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, contributions: project.contributions });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

// ── DELETE /projects/:projectId ───────────────────────────────────────────────
router.delete("/:projectId", async (req, res) => {
  try {
    const { username } = req.body;
    const project = await Project.findOne({ projectId: req.params.projectId });
    if (!project) return res.status(404).json({ success: false, message: "Not found" });
    if (project.admin !== username) return res.status(403).json({ success: false, message: "Admin only" });
    await project.deleteOne();
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: "Server error" }); }
});

module.exports = router;