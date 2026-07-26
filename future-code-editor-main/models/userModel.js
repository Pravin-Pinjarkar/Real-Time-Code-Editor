/**
 * models/userModel.js (v5)
 *
 * FIX: "Users not appearing in DB"
 *
 * Two root causes:
 * 1. The findOneAndUpdate in auth.js used $set with fields not defined
 *    in the schema (e.g. lastLogin). With strict:true (the default),
 *    Mongoose silently drops fields not in the schema — so the document
 *    is created but looks empty except for _id and email.
 *
 * 2. The password field had no index and email was case-sensitive,
 *    which caused duplicate key errors on re-login → upsert silently failed.
 *
 * SOLUTION:
 * - Keep the schema clean with all needed fields explicitly defined
 * - Set { strict: true } (safe) but make sure all fields in the upsert
 *   are present in the schema
 * - The auth.js route was already using findOneAndUpdate correctly
 *   (see routes/auth.js) — this schema makes it actually persist data
 */
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email:     { type: String, unique: true, required: true, lowercase: true, trim: true },
    username:  { type: String, trim: true, default: "" },
    password:  { type: String, default: "clerk-auth" },
    lastLogin: { type: Date,   default: Date.now },
  },
  {
    timestamps: true,   // adds createdAt + updatedAt automatically
    strict: true,       // safe — all needed fields are now in schema
  }
);

module.exports = mongoose.model("User", userSchema);