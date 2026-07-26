/**
 * models/projectModel.js (v5)
 *
 * FIX for "code not saving to DB":
 * The main issue was that Mongoose tracks changes to subdocument arrays
 * only when you use .push() or .splice(). When you mutate a nested field
 * directly (file.content = "..."), Mongoose doesn't know it changed.
 * The route must call project.markModified("files") before project.save().
 * That fix is in routes/projects.js — but we also make the schema more robust.
 *
 * Also added:
 * - localPath field (was missing, causing silent drops)
 * - timestamps on project level
 */
const mongoose = require("mongoose");

// ── File subdocument ────────────────────────────────────────────────────────
const fileSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  language:       { type: String, default: "plaintext" },
  content:        { type: String, default: "" },        // ← the actual code
  createdBy:      { type: String },
  updatedBy:      { type: String },
  updatedAt:      { type: Date, default: Date.now },
  pendingContent: { type: String, default: null },
  pendingBy:      { type: String, default: null },
}, { _id: true });

// ── Contribution entry ──────────────────────────────────────────────────────
const contributionSchema = new mongoose.Schema({
  username:     { type: String, required: true },
  linesAdded:   { type: Number, default: 0 },
  linesRemoved: { type: Number, default: 0 },
  edits:        { type: Number, default: 0 },
  lastActive:   { type: Date,   default: Date.now },
}, { _id: false });

// ── Chat message ─────────────────────────────────────────────────────────────
const chatMsgSchema = new mongoose.Schema({
  from:      { type: String, required: true },
  text:      { type: String, required: true },
  timestamp: { type: Date,   default: Date.now },
}, { _id: false });

// ── Project (main) ────────────────────────────────────────────────────────────
const projectSchema = new mongoose.Schema({
  projectId:    { type: String, unique: true, required: true },
  name:         { type: String, required: true },
  admin:        { type: String, required: true },
  members:      [{ type: String }],
  invitedUsers: [{ type: String }],
  files:        [fileSchema],
  chatHistory:  [chatMsgSchema],
  contributions:[contributionSchema],
  localPath:    { type: String, default: null },        // ← was missing before
}, { timestamps: true });

// ── Helper: upsert contribution ───────────────────────────────────────────────
projectSchema.methods.trackContribution = function(username, linesAdded = 0, linesRemoved = 0) {
  const existing = this.contributions.find(c => c.username === username);
  if (existing) {
    existing.linesAdded   += linesAdded;
    existing.linesRemoved += linesRemoved;
    existing.edits        += 1;
    existing.lastActive    = new Date();
  } else {
    this.contributions.push({ username, linesAdded, linesRemoved, edits: 1 });
  }
  // Mark modified so Mongoose saves the change
  this.markModified("contributions");
};

module.exports = mongoose.model("Project", projectSchema);