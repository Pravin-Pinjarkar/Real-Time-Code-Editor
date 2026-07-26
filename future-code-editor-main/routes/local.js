/**
 * routes/local.js
 *
 * Backend routes for the "local path" feature.
 * Lets users save project files to a real directory on the server machine
 * (or their own machine when running locally).
 *
 * Endpoints:
 *   POST /local/validate   - check if path exists and is writable
 *   POST /local/save       - write all project files to path
 *   POST /local/mkdir      - create a new directory
 *   GET  /local/tree       - list directory tree
 */

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");

// ── Safety: disallow paths that escape certain roots ─────────────────────────
// In production you'd lock this to user-specific sandboxes.
// For a local dev tool, we allow any absolute or relative path.
function _safePath(inputPath) {
  // Resolve ~
  if (inputPath.startsWith("~")) {
    inputPath = inputPath.replace("~", process.env.HOME || process.env.USERPROFILE || "");
  }
  return path.resolve(inputPath);
}

function _pathError(res, msg, code = 400) {
  return res.status(code).json({ success: false, message: msg });
}

// ── POST /local/validate ─────────────────────────────────────────────────────
// body: { path: string }
// Returns: { success, exists, writable, isDirectory }
router.post("/validate", (req, res) => {
  const { path: inputPath } = req.body;

  if (!inputPath || typeof inputPath !== "string") {
    return _pathError(res, "path is required");
  }

  let resolved;
  try {
    resolved = _safePath(inputPath.trim());
  } catch (err) {
    return _pathError(res, "Invalid path format: " + err.message);
  }

  let exists      = false;
  let isDirectory = false;
  let writable    = false;

  try {
    const stat = fs.statSync(resolved);
    exists      = true;
    isDirectory = stat.isDirectory();

    // Check writability
    fs.accessSync(resolved, fs.constants.W_OK);
    writable = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Path exists but other error (permission, etc.)
      exists = true;
      writable = false;
    }
    // ENOENT → path doesn't exist → exists stays false
  }

  return res.json({
    success:     true,
    resolved,
    exists,
    isDirectory,
    writable,
    message: !exists
      ? "Path does not exist. It will be created when you save."
      : (!isDirectory ? "Path exists but is a file, not a folder." : ""),
  });
});

// ── POST /local/mkdir ─────────────────────────────────────────────────────────
// body: { path: string }
router.post("/mkdir", (req, res) => {
  const { path: inputPath } = req.body;
  if (!inputPath) return _pathError(res, "path is required");

  let resolved;
  try {
    resolved = _safePath(inputPath.trim());
  } catch (err) {
    return _pathError(res, "Invalid path: " + err.message);
  }

  try {
    fs.mkdirSync(resolved, { recursive: true });
    return res.json({ success: true, resolved, message: "Directory created" });
  } catch (err) {
    return _pathError(res, "Could not create directory: " + err.message);
  }
});

// ── POST /local/save ─────────────────────────────────────────────────────────
// body: { path: string, files: [{ name, content }] }
router.post("/save", (req, res) => {
  const { path: inputPath, files } = req.body;

  if (!inputPath) return _pathError(res, "path is required");
  if (!Array.isArray(files) || files.length === 0) {
    return _pathError(res, "No files provided");
  }

  let resolved;
  try {
    resolved = _safePath(inputPath.trim());
  } catch (err) {
    return _pathError(res, "Invalid path: " + err.message);
  }

  // Create directory if it doesn't exist
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (err) {
    return _pathError(res, "Cannot create directory: " + err.message);
  }

  const saved  = [];
  const errors = [];

  files.forEach(file => {
    if (!file.name) return;

    // Sanitize filename — prevent directory traversal
    const safeName = path.basename(file.name);
    const filePath = path.join(resolved, safeName);

    try {
      fs.writeFileSync(filePath, file.content || "", "utf8");
      saved.push(safeName);
    } catch (err) {
      errors.push({ file: safeName, error: err.message });
    }
  });

  return res.json({
    success: errors.length === 0,
    saved,
    errors,
    message: errors.length > 0
      ? `${saved.length} saved, ${errors.length} failed`
      : `${saved.length} file(s) saved to ${resolved}`,
  });
});

// ── GET /local/tree ───────────────────────────────────────────────────────────
// query: ?path=...&depth=2
router.get("/tree", (req, res) => {
  const { path: inputPath, depth = "2" } = req.query;
  if (!inputPath) return _pathError(res, "path is required");

  let resolved;
  try {
    resolved = _safePath(inputPath.trim());
  } catch (err) {
    return _pathError(res, "Invalid path");
  }

  if (!fs.existsSync(resolved)) {
    return _pathError(res, "Path does not exist");
  }

  const maxDepth = Math.min(parseInt(depth, 10) || 2, 5); // cap at 5

  function buildTree(dirPath, currentDepth) {
    if (currentDepth > maxDepth) return [];
    let items;
    try {
      items = fs.readdirSync(dirPath);
    } catch {
      return [];
    }
    return items
      .filter(name => !name.startsWith("."))  // skip hidden
      .map(name => {
        const full = path.join(dirPath, name);
        let stat;
        try { stat = fs.statSync(full); } catch { return null; }
        const isDir = stat.isDirectory();
        return {
          name,
          type:     isDir ? "directory" : "file",
          children: isDir ? buildTree(full, currentDepth + 1) : undefined,
        };
      })
      .filter(Boolean);
  }

  return res.json({
    success: true,
    root:    resolved,
    tree:    buildTree(resolved, 1),
  });
});

module.exports = router;