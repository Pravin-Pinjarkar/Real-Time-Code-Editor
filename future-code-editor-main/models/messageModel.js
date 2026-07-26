const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  room: String,
  username: String,
  text: String,
  timestamp: { type: Date, default: Date.now },
  isDM: { type: Boolean, default: false },
  participants: [String],
});

module.exports = mongoose.model("Message", messageSchema);