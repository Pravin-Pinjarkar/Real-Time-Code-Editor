const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const FileMeta = require("../models/fileModel");

const UPLOAD_DIR = process.env.DIR || path.join(__dirname, "../uploads");
const JWT_SECRET = process.env.JWT_SECRET || "dev-jwt-secret-change-me";
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || "10485760", 10);

const ENC_KEY = crypto
  .createHash("sha256")
  .update(process.env.FILE_KEY || "dev-file-key-change-me")
  .digest();

// Ensure upload directory exists
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("📁 Upload dir ready:", UPLOAD_DIR);
} catch (err) {
  console.error("❌ Could not create upload dir:", UPLOAD_DIR, err.message);
  console.error("💡 Fix: set DIR=./uploads in your .env");
  process.exit(1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

function decryptBuffer(encrypted, ivHex, authTagHex) {
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function createThumbnail(buffer, storedName) {
  try {
    const thumbName = "thumb_" + storedName + ".jpg";
    const thumbPath = path.join(UPLOAD_DIR, thumbName);
    await sharp(buffer)
      .resize(200, 200, { fit: "cover" })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);
    return thumbName;
  } catch (err) {
    console.error("Thumbnail error:", err);
    return null;
  }
}

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const { sender, receiver } = req.body;
    const buffer = req.file.buffer;
    const { encrypted, iv, authTag } = encryptBuffer(buffer);

    const storedName = Date.now() + "_" + crypto.randomBytes(8).toString("hex") + ".bin";
    const filePath = path.join(UPLOAD_DIR, storedName);

    await fs.promises.writeFile(filePath, encrypted);

    const hash = crypto.createHash("sha256").update(encrypted).digest("hex");

    let thumbnailName = null;
    if (req.file.mimetype && req.file.mimetype.startsWith("image/")) {
      thumbnailName = await createThumbnail(buffer, storedName);
    }

    const meta = await FileMeta.create({
      originalName: req.file.originalname,
      storedName,
      sender: sender || null,
      receiver: receiver || null,
      size: req.file.size,
      mimeType: req.file.mimetype || "application/octet-stream",
      hash,
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      thumbnailName,
    });

    const downloadToken = jwt.sign(
      { fileId: meta._id.toString() },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    console.log("📁 File stored:", meta.originalName, "=>", storedName);

    res.json({
      success: true,
      fileId: meta._id,
      downloadToken,
      message: "File saved securely",
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

router.get("/file/:id", async (req, res) => {
  try {
    const { token } = req.query;
    const fileId = req.params.id;

    if (!token) {
      return res.status(401).json({ success: false, message: "Missing token" });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    if (payload.fileId !== fileId) {
      return res.status(403).json({ success: false, message: "Token does not match file" });
    }

    const meta = await FileMeta.findById(fileId);
    if (!meta) {
      return res.status(404).json({ success: false, message: "File not found" });
    }

    const filePath = path.join(UPLOAD_DIR, meta.storedName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: "Stored file missing" });
    }

    const encrypted = await fs.promises.readFile(filePath);
    const decrypted = decryptBuffer(encrypted, meta.iv, meta.authTag);

    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename=\"" + (meta.originalName || "file") + "\"");
    res.send(decrypted);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/file/:id/thumbnail", async (req, res) => {
  try {
    const meta = await FileMeta.findById(req.params.id);
    if (!meta || !meta.thumbnailName) {
      return res.status(404).json({ success: false, message: "Thumbnail not found" });
    }

    const thumbPath = path.join(UPLOAD_DIR, meta.thumbnailName);
    if (!fs.existsSync(thumbPath)) {
      return res.status(404).json({ success: false, message: "Thumbnail missing" });
    }

    res.sendFile(thumbPath);
  } catch (err) {
    console.error("Thumbnail get error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;