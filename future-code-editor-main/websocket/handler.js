/**
 * websocket/handler.js
 * Handles all WebSocket messages including the new CRDT-based
 * editor collaboration protocol.
 *
 * New message types vs previous version:
 *   editor-op      → broadcast operation delta to room (replaces editor-update)
 *   editor-full    → broadcast full content to room (for late joiners)
 *   cursor-update  → broadcast cursor position to room
 *   line-lock      → broadcast line lock to room
 *   line-unlock    → broadcast line unlock to room
 *   file-switch    → broadcast file switch to room
 *   typing-project → "user is typing" in project chat
 */

const WebSocket = require("ws");
const Message   = require("../models/messageModel");

// ── In-memory state ──────────────────────────────────────────────────────────
const rooms        = {};          // room → [ws, ...]
const userSockets  = new Map();   // username → ws
const userStatus   = new Map();   // username → { status, lastSeen }
const typingUsers  = new Map();   // room → Set<username>
const privateChats = new Map();   // username → Set<username>
const contacts     = new Map();   // username → string[]

// ── Helpers ──────────────────────────────────────────────────────────────────

function broadcastToRoom(room, payload, excludeWs = null) {
  (rooms[room] || []).forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}

function broadcastOnlineUsers(room) {
  const users = (rooms[room] || [])
    .filter(ws => ws.user)
    .map(ws => ({
      username: ws.user,
      status:   userStatus.get(ws.user)?.status || "online",
      avatar:   ws.user.charAt(0).toUpperCase(),
    }));
  broadcastToRoom(room, { type: "online", users });
}

function getAllOnlineUsers() {
  return Array.from(userSockets.keys()).map(username => ({
    username,
    status:   userStatus.get(username)?.status || "online",
    avatar:   username.charAt(0).toUpperCase(),
    lastSeen: userStatus.get(username)?.lastSeen || Date.now(),
  }));
}

function sendToUser(username, payload) {
  const ws = userSockets.get(username);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function broadcastTypingStatus(room) {
  broadcastToRoom(room, {
    type:  "typing",
    users: Array.from(typingUsers.get(room) || []),
  });
}

function broadcastUserUpdate() {
  const payload = JSON.stringify({ type: "allUsers", users: getAllOnlineUsers() });
  userSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

// ── Main setup ───────────────────────────────────────────────────────────────

function setupWebSocket(wss) {
  wss.on("connection", ws => {
    ws.user    = null;
    ws.email   = null;
    ws.room    = null;
    ws.isAlive = true;

    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", async raw => {
      let msg;
      try { msg = JSON.parse(raw); }
      catch { console.warn("WS: invalid JSON"); return; }

      // ── Routing ──────────────────────────────────────────────────────────

      switch (msg.type) {

        // ── Identity ────────────────────────────────────────────────────────
        case "setName": {
          ws.user  = msg.name  || ws.user;
          ws.email = msg.email || ws.email;
          userSockets.set(ws.user, ws);
          userStatus.set(ws.user, { status: msg.status || "online", lastSeen: Date.now() });
          if (!contacts.has(ws.user)) contacts.set(ws.user, []);
          ws.send(JSON.stringify({ type: "userInfo", username: ws.user, email: ws.email }));
          ws.send(JSON.stringify({ type: "allUsers", users: getAllOnlineUsers() }));
          broadcastUserUpdate();
          break;
        }

        // ── Join project room ────────────────────────────────────────────────
        case "join": {
          const room = msg.room;
          if (!room) break;

          // Leave old room
          if (ws.room && rooms[ws.room]) {
            rooms[ws.room] = rooms[ws.room].filter(s => s !== ws);
            broadcastOnlineUsers(ws.room);
            if (typingUsers.has(ws.room)) {
              typingUsers.get(ws.room).delete(ws.user);
              broadcastTypingStatus(ws.room);
            }
          }

          ws.room = room;
          if (!rooms[room]) rooms[room] = [];
          rooms[room].push(ws);

          ws.send(JSON.stringify({ type: "joinedRoom", room }));
          broadcastOnlineUsers(room);

          // Send last 50 project chat messages
          try {
            const msgs = await Message.find({ room, isDM: false })
              .sort({ timestamp: 1 }).limit(50);
            msgs.forEach(m => {
              ws.send(JSON.stringify({
                type: "chat",
                data: { from: m.username, text: m.text, timestamp: m.timestamp, id: m._id },
              }));
            });
          } catch (err) { console.error("WS join load messages:", err); }

          broadcastToRoom(room, {
            type: "system", message: `${ws.user || "Someone"} joined`, timestamp: new Date(),
          }, ws);
          break;
        }

        // ── CRDT: operation delta ────────────────────────────────────────────
        // Broadcast the raw Monaco change delta to all other room members.
        // The receiving client applies it directly to the Monaco model.
        case "editor-op": {
          if (!ws.room) break;
          broadcastToRoom(ws.room, {
            type:    "editor-op",
            from:    ws.user,
            file:    msg.file,
            changes: msg.changes,
          }, ws);
          break;
        }

        // ── CRDT: full content sync (for late joiners) ───────────────────────
        case "editor-full": {
          if (!ws.room) break;
          broadcastToRoom(ws.room, {
            type:    "editor-full",
            from:    ws.user,
            file:    msg.file,
            content: msg.content,
            lang:    msg.lang,
          }, ws);
          break;
        }

        // ── CRDT: cursor position ────────────────────────────────────────────
        case "cursor-update": {
          if (!ws.room) break;
          broadcastToRoom(ws.room, {
            type:      "cursor-update",
            from:      ws.user,
            file:      msg.file,
            selection: msg.selection,
          }, ws);
          break;
        }

        // ── CRDT: line lock / unlock ─────────────────────────────────────────
        case "line-lock": {
          if (!ws.room) break;
          broadcastToRoom(ws.room, {
            type:  "line-lock",
            from:  ws.user,
            file:  msg.file,
            range: msg.range,
          }, ws);
          break;
        }
        case "line-unlock": {
          if (!ws.room) break;
          broadcastToRoom(ws.room, {
            type: "line-unlock",
            from: ws.user,
            file: msg.file,
          }, ws);
          break;
        }

        // ── CRDT: file switch ────────────────────────────────────────────────
        case "file-switch": {
          if (!ws.room) break;
          broadcastToRoom(ws.room, {
            type:     "file-switch",
            from:     ws.user,
            file:     msg.file,
            prevFile: msg.prevFile,
          }, ws);
          break;
        }

        // ── Project chat ─────────────────────────────────────────────────────
        case "chat": {
          if (!ws.room) break;
          const chatData = {
            room:      ws.room,
            username:  ws.user || "Anonymous",
            text:      msg.text,
            timestamp: new Date(),
            isDM:      false,
          };
          try {
            const saved = await new Message(chatData).save();
            broadcastToRoom(ws.room, {
              type: "chat",
              data: { from: chatData.username, text: chatData.text, timestamp: chatData.timestamp, id: saved._id },
            });
            if (typingUsers.has(ws.room)) {
              typingUsers.get(ws.room).delete(ws.user);
              broadcastTypingStatus(ws.room);
            }
          } catch (err) { console.error("WS chat save:", err); }
          break;
        }

        // ── Direct message ───────────────────────────────────────────────────
        case "dm": {
          const { to: recipient, text } = msg;
          if (!recipient || !text) break;
          const dmData = {
            room:         `dm_${[ws.user, recipient].sort().join("_")}`,
            username:     ws.user,
            text,
            timestamp:    new Date(),
            isDM:         true,
            participants: [ws.user, recipient],
          };
          try {
            const saved = await new Message(dmData).save();
            sendToUser(recipient, { type: "dm", from: ws.user, text, timestamp: dmData.timestamp, id: saved._id });
            ws.send(JSON.stringify({ type: "dm-sent", to: recipient, text, timestamp: dmData.timestamp, id: saved._id }));
            if (!privateChats.has(ws.user))   privateChats.set(ws.user, new Set());
            if (!privateChats.has(recipient))  privateChats.set(recipient, new Set());
            privateChats.get(ws.user).add(recipient);
            privateChats.get(recipient).add(ws.user);
          } catch (err) { console.error("WS dm save:", err); }
          break;
        }

        // ── Load DM history ──────────────────────────────────────────────────
        case "load-dm": {
          const dmRoom = `dm_${[ws.user, msg.with].sort().join("_")}`;
          try {
            const msgs = await Message.find({ room: dmRoom, isDM: true }).sort({ timestamp: 1 }).limit(50);
            ws.send(JSON.stringify({
              type: "dm-history",
              with: msg.with,
              messages: msgs.map(m => ({ from: m.username, text: m.text, timestamp: m.timestamp, id: m._id })),
            }));
          } catch (err) { console.error("WS load-dm:", err); }
          break;
        }

        // ── Contacts ─────────────────────────────────────────────────────────
        case "add-contact": {
          if (!contacts.has(ws.user)) contacts.set(ws.user, []);
          const list = contacts.get(ws.user);
          if (!list.includes(msg.username)) {
            list.push(msg.username);
            ws.send(JSON.stringify({ type: "contact-added", username: msg.username }));
          }
          break;
        }
        case "get-contacts": {
          const list = contacts.get(ws.user) || [];
          ws.send(JSON.stringify({
            type: "contacts-list",
            contacts: list.map(u => ({
              username: u,
              online:   userSockets.has(u),
              status:   userStatus.get(u)?.status || "offline",
              avatar:   u.charAt(0).toUpperCase(),
            })),
          }));
          break;
        }

        // ── Typing ───────────────────────────────────────────────────────────
        case "typing": {
          if (msg.isDM && msg.to) {
            sendToUser(msg.to, { type: "typing-dm", from: ws.user, isTyping: msg.isTyping });
          } else if (ws.room) {
            if (!typingUsers.has(ws.room)) typingUsers.set(ws.room, new Set());
            const set = typingUsers.get(ws.room);
            if (msg.isTyping) set.add(ws.user); else set.delete(ws.user);
            broadcastTypingStatus(ws.room);
          }
          break;
        }

        // ── Status ───────────────────────────────────────────────────────────
        case "status": {
          if (!ws.user) break;
          userStatus.set(ws.user, { status: msg.status, lastSeen: Date.now() });
          broadcastUserUpdate();
          if (ws.room) broadcastOnlineUsers(ws.room);
          break;
        }

        // ── WebRTC signaling ─────────────────────────────────────────────────
        case "webrtc-offer":
        case "webrtc-answer":
        case "webrtc-ice": {
          const ok = sendToUser(msg.to, { type: msg.type, from: ws.user, data: msg.data });
          if (!ok) ws.send(JSON.stringify({ type: "error", message: `User ${msg.to} is offline` }));
          break;
        }

        // ── File transfer metadata ────────────────────────────────────────────
        case "file-offer": {
          sendToUser(msg.to, { type: "file-offer", from: ws.user, fileName: msg.fileName, fileSize: msg.fileSize, fileType: msg.fileType });
          break;
        }
        case "file-response": {
          sendToUser(msg.to, { type: "file-response", from: ws.user, accepted: msg.accepted });
          break;
        }

        // ── Video calls ───────────────────────────────────────────────────────
        case "call-initiate": {
          sendToUser(msg.to, { type: "incoming-call", from: ws.user, callType: msg.callType });
          break;
        }
        case "call-response": {
          sendToUser(msg.to, { type: "call-response", from: ws.user, accepted: msg.accepted });
          break;
        }
        case "call-end": {
          sendToUser(msg.to, { type: "call-ended", from: ws.user });
          break;
        }

        default:
          // Unknown message type — silently ignore
          break;
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    ws.on("close", () => {
      if (ws.user) {
        userSockets.delete(ws.user);
        userStatus.set(ws.user, { status: "offline", lastSeen: Date.now() });
      }
      if (ws.room && rooms[ws.room]) {
        rooms[ws.room] = rooms[ws.room].filter(s => s !== ws);
        broadcastToRoom(ws.room, {
          type: "system", message: `${ws.user || "Someone"} left`, timestamp: new Date(),
        });
        broadcastOnlineUsers(ws.room);
        if (typingUsers.has(ws.room)) {
          typingUsers.get(ws.room).delete(ws.user);
          broadcastTypingStatus(ws.room);
        }
        // Broadcast line-unlock for this user
        broadcastToRoom(ws.room, { type: "line-unlock", from: ws.user });
        // Broadcast file-switch so cursors are cleared
        broadcastToRoom(ws.room, { type: "file-switch", from: ws.user, file: null });
      }
      broadcastUserUpdate();
    });

    ws.on("error", err => console.error("WS error:", err));
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  const hb = setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(hb));
}

module.exports = setupWebSocket;