/**
 * AppProof Relay Server
 *
 * Connects phone agents and desktop controllers.
 * Each pair joins a "room" identified by a 6-digit code.
 * Messages are forwarded between all participants in a room.
 *
 * Protocols:
 *   WS /join/:code/:role  - Join room (role: controller | agent)
 *   GET /health            - Health check
 *   GET /rooms             - List active rooms
 */

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomInt } from "node:crypto";

const PORT = parseInt(process.env.PORT ?? "3200");

// Room storage
const rooms = new Map();

function generateCode() {
  let code;
  do { code = String(randomInt(100000, 999999)); } while (rooms.has(code));
  return code;
}

// HTTP server
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (url.pathname === "/health") {
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size, uptime: process.uptime() }));
    return;
  }

  if (url.pathname === "/rooms") {
    const list = [];
    for (const [code, room] of rooms) {
      list.push({
        code,
        hasController: !!room.controller,
        agents: room.agents.size,
        lastActivity: room.lastActivity,
      });
    }
    res.end(JSON.stringify({ rooms: list }));
    return;
  }

  if (url.pathname === "/create") {
    const code = generateCode();
    rooms.set(code, { controller: null, agents: new Map(), createdAt: Date.now(), lastActivity: Date.now() });
    res.end(JSON.stringify({ code }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found. Use /health, /rooms, /create, or WS /join/:code/:role" }));
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/join\/(\d{6})\/(controller|agent)$/);

  if (!match) {
    ws.close(4000, "Use /join/:code/:role");
    return;
  }

  const code = match[1];
  const role = match[2];
  const deviceId = url.searchParams.get("deviceId") ?? `agent-${Date.now()}`;

  // Auto-create room
  if (!rooms.has(code)) {
    rooms.set(code, { controller: null, agents: new Map(), createdAt: Date.now(), lastActivity: Date.now() });
  }

  const room = rooms.get(code);

  if (role === "controller") {
    if (room.controller && room.controller.readyState === WebSocket.OPEN) {
      room.controller.close(4001, "Replaced by new controller");
    }
    room.controller = ws;
    console.log(`[${code}] Controller joined`);
  } else {
    room.agents.set(deviceId, ws);
    console.log(`[${code}] Agent joined: ${deviceId}`);
  }

  room.lastActivity = Date.now();

  // Notify others
  broadcast(room, ws, JSON.stringify({ type: "peer_joined", role, deviceId }));

  // Forward messages
  ws.on("message", (data) => {
    room.lastActivity = Date.now();
    broadcast(room, ws, data);
  });

  ws.on("close", () => {
    if (room.controller === ws) {
      room.controller = null;
      console.log(`[${code}] Controller left`);
    }
    for (const [id, sock] of room.agents) {
      if (sock === ws) { room.agents.delete(id); console.log(`[${code}] Agent left: ${id}`); break; }
    }
    broadcast(room, null, JSON.stringify({ type: "peer_left", role, deviceId }));

    // Clean empty rooms
    if (!room.controller && room.agents.size === 0) {
      rooms.delete(code);
      console.log(`[${code}] Room deleted (empty)`);
    }
  });
});

function broadcast(room, sender, data) {
  const send = (ws) => {
    if (ws && ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  send(room.controller);
  for (const ws of room.agents.values()) send(ws);
}

// Cleanup stale rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 3600000 && !room.controller && room.agents.size === 0) {
      rooms.delete(code);
    }
  }
}, 600000);

server.listen(PORT, () => {
  console.log(`AppProof Relay running on port ${PORT}`);
  console.log(`WS: /join/:code/controller or /join/:code/agent`);
  console.log(`HTTP: /health, /rooms, /create`);
});
