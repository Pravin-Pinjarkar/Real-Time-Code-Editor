/**
 * models/fileMeta.js
 *
 * Schema for P2P file transfer metadata.
 * Stores AES-256-GCM encrypted originalName along with
 * sender, receiver, and encryption parameters (iv, authTag, hash).
 *
 * This is re-exported from fileModel.js for backward compatibility.
 * The model name "FileMeta" is shared.
 */
const mongoose = require("mongoose");

const fileMetaSchema = new mongoose.Schema({
  originalName:  { type: String, required: true },   // AES-256-GCM encrypted (base64)
  storedName:    { type: String, default: null },     // server-side stored filename (if any)
  sender:        { type: String, required: true },    // username who sent the file
  receiver:      { type: String, required: true },    // username who received the file
  size:          { type: Number, default: 0 },        // file size in bytes
  mimeType:      { type: String, default: "application/octet-stream" },

  // AES-256-GCM encryption metadata
  hash:          { type: String, default: null },     // SHA-256 hash of the plaintext filename
  iv:            { type: String, default: null },     // initialization vector (hex)
  authTag:       { type: String, default: null },     // GCM auth tag (hex)

  thumbnailName: { type: String, default: null },
  transferType:  { type: String, enum: ["p2p", "server"], default: "p2p" },
  createdAt:     { type: Date,   default: Date.now },
});

// Prevent OverwriteModelError if model already registered
module.exports = mongoose.models.FileMeta || mongoose.model("FileMeta", fileMetaSchema);
