const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema({
  originalName: String,
  storedName: String,
  sender: String,
  receiver: String,
  size: Number,
  mimeType: String,
  hash: String,
  iv: String,
  authTag: String,
  thumbnailName: String,
  transferType: { type: String, enum: ["p2p", "server"], default: "p2p" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.FileMeta || mongoose.model("FileMeta", fileSchema);