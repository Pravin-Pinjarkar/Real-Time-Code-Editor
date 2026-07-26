require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const connectDB = require("./config/db");
const authRoutes = require("./routes/auth");
const fileRoutes = require("./routes/files");
const setupWebSocket = require("./websocket/handler");

const projectRoutes = require("./routes/projects");
const aiRoutes = require("./routes/ai");
const localRoutes = require("./routes/local");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const executeRoute = require("./routes/execute");

// ─── Middleware ─────────────────────────
app.use(express.json());
app.use(express.static("public"));
app.use("/execute", executeRoute);

// ─── CONFIG ROUTE ───────────────────────
app.get("/config", (req, res) => {
  res.json({
    clerkPublishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY,
    fileKey: process.env.FILE_KEY || null,
  });
});

// ─── FILE META ROUTE (P2P transfer metadata with AES-256-GCM) ─────
const crypto   = require("crypto");
const FileMeta = require("./models/fileMeta");

function _encryptAES256(plaintext, keyHex) {
  if (!keyHex) return { encrypted: plaintext, iv: null, authTag: null, hash: null };
  const key     = Buffer.from(keyHex, "hex").slice(0, 32); // 256-bit
  const iv      = crypto.randomBytes(12);
  const cipher  = crypto.createCipheriv("aes-256-gcm", key, iv);
  let enc       = cipher.update(plaintext, "utf8", "hex");
  enc          += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  const hash    = crypto.createHash("sha256").update(plaintext).digest("hex");
  return { encrypted: enc, iv: iv.toString("hex"), authTag, hash };
}

app.post("/files/meta", async (req, res) => {
  try {
    const { originalName, sender, receiver, size, mimeType } = req.body;
    if (!originalName || !sender || !receiver) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // Encrypt the original filename with AES-256-GCM using FILE_KEY from .env
    const fileKey = process.env.FILE_KEY || null;
    const { encrypted, iv, authTag, hash } = _encryptAES256(originalName, fileKey);

    const doc = await new FileMeta({
      originalName: encrypted,
      sender,
      receiver,
      size:       size || 0,
      mimeType:   mimeType || "application/octet-stream",
      iv,
      authTag,
      hash,
      transferType: "p2p",
    }).save();
    res.json({ success: true, id: doc._id });
  } catch (err) {
    console.error("FileMeta save error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── NORMAL ROUTES ──────────────────────
app.use("/", authRoutes);
app.use("/", fileRoutes);
app.use("/projects", projectRoutes);
app.use("/ai", aiRoutes);
app.use("/local", localRoutes);


// ─── WebSocket ──────────────────────────
setupWebSocket(wss);

// ─── START SERVER ───────────────────────
const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(` HybridLink Server running on http://localhost:${PORT}`);
    console.log(` WebSocket server ready`);
    console.log(` WebRTC signaling enabled`);
    console.log(` file transfer`);
    console.log(` Judge0 execution enabled`);
  });
});