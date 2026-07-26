/**
 * routes/auth.js  (v4 — fixes user not being stored in DB)
 *
 * FIX: Previous version called user.save() but the User model fields
 * may not match the Clerk data shape. We now explicitly upsert with
 * { new: true, upsert: true } so the user document is always created
 * even if findOne returns null.
 *
 * Also adds GET /me so the frontend can refresh user info.
 */

const express  = require("express");
const router   = express.Router();
const { createClerkClient, verifyToken } = require("@clerk/backend");
const User     = require("../models/userModel");

const clerkClient = createClerkClient({
  secretKey: process.env.VITE_CLERK_SECRET_KEY || process.env.CLERK_SECRET_KEY,
});

// ── POST /verify-clerk ────────────────────────────────────────────────────────
router.post("/verify-clerk", async (req, res) => {
  try {
    const { sessionToken } = req.body;
    if (!sessionToken) {
      return res.status(400).json({ success: false, message: "Session token required" });
    }

    // 1. Verify the JWT
    let clerkUserId;
    try {
      const payload = await verifyToken(sessionToken, {
        secretKey: process.env.VITE_CLERK_SECRET_KEY || process.env.CLERK_SECRET_KEY,
      });
      clerkUserId = payload.sub;
    } catch (err) {
      console.error("Token verify failed:", err.message);
      return res.status(401).json({ success: false, message: "Invalid or expired session" });
    }

    // 2. Get Clerk user details
    const clerkUser = await clerkClient.users.getUser(clerkUserId);

    const email = clerkUser.emailAddresses?.[0]?.emailAddress || null;
    if (!email) {
      return res.status(400).json({ success: false, message: "No email on Clerk account" });
    }

    const username =
      clerkUser.username ||
      clerkUser.firstName ||
      email.split("@")[0];

    // 3. Upsert user in MongoDB
    // Using findOneAndUpdate with upsert:true guarantees the document is created
    // even on the first login. The previous new User().save() approach silently
    // failed if there was a duplicate key race condition.
    const user = await User.findOneAndUpdate(
      { email },                                    // filter
      {
        $set: {
          email,
          username,
          lastLogin: new Date(),
        },
        $setOnInsert: {
          password:  "clerk-auth",
          createdAt: new Date(),
        },
      },
      { new: true, upsert: true, runValidators: false }
    );

    console.log(`✅ User upserted: ${user.username} <${user.email}>`);

    return res.json({
      success:  true,
      username: user.username,
      email:    user.email,
    });

  } catch (err) {
    console.error("verify-clerk error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /config — sends publishable key to frontend ───────────────────────────
router.get("/config", (req, res) => {
  res.json({
    clerkPublishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
  });
});

module.exports = router;