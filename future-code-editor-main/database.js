const mongoose = require("mongoose");
require("dotenv").config();

const uri = process.env.MONGO_URI;

mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB connected"))
    .catch((err) => console.error("❌ MongoDB connection error:", err));

const messageSchema = new mongoose.Schema({
    room: String,
    username: String,
    text: String,
    timestamp: { type: Date, default: Date.now },
    isDM: { type: Boolean, default: false },
    participants: [String] // For DMs
});

const Message = mongoose.model("Message", messageSchema);

module.exports = { Message };