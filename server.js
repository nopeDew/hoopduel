const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

io.on("connection", socket => {
  socket.on("createRoom", ({ name }) => {
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const player = { id: socket.id, name: cleanName(name), side: 1, x: 180, y: 390, vx: 0, vy: 0, score: 0, ready: false };
    rooms.set(code, { code, players: [player], ball: { x: 450, y: 300, vx: 0, vy: 0, owner: null }, started: false, lastTick: Date.now() });
    socket.join(code);
    socket.data.room = code;
    socket.emit("roomJoined", publicRoom(rooms.get(code)));
  });

  socket.on("joinRoom", ({ code, name }) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("joinError", "Room not found. Check the code.");
    if (room.players.length >= 2) return socket.emit("joinError", "That room is full.");
    const player = { id: socket.id, name: cleanName(name), side: 2, x: 720, y: 390, vx: 0, vy: 0, score: 0, ready: false };
    room.players.push(player);
    socket.join(code);
    socket.data.room = code;
    io.to(code).emit("roomJoined", publicRoom(room));
  });

  socket.on("ready", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) p.ready = true;
    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.started = true;
      room.lastTick = Date.now();
      io.to(room.code).emit("gameStarted");
    }
    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    p.input = {
      left: !!input.left, right: !!input.right, up: !!input.up,
      shoot: !!input.shoot, steal: !!input.steal
    };
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (!room.players.length) rooms.delete(code);
    else {
      room.started = false;
      io.to(code).emit("opponentLeft");
      io.to(code).emit("roomUpdate", publicRoom(room));
    }
  });
});

function cleanName(value) {
  return String(value || "Player").replace(/[<>]/g, "").trim().slice(0, 14) || "Player";
}
function publicRoom(room) {
  return { code: room.code, players: room.players.map(p => ({ name: p.name, side: p.side, score: p.score, ready: p.ready })), started: room.started };
}

// Lightweight authoritative game loop. Server owns movement, ball and scoring.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started || room.players.length !== 2) continue;
    const dt = Math.min((now - room.lastTick) / 1000, 0.05);
    room.lastTick = now;
    const [a, b] = room.players;
    for (const p of room.players) {
      const i = p.input || {};
      p.vx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
      p.x += p.vx * 260 * dt;
      p.x = Math.max(35, Math.min(865, p.x));
      if (i.up && p.y >= 390) p.vy = -410;
      p.vy += 980 * dt;
      p.y += p.vy * dt;
      if (p.y > 390) { p.y = 390; p.vy = 0; }
    }

    const ball = room.ball;
    // Possession follows the player who currently owns it.
    if (ball.owner) {
      const holder = room.players.find(p => p.id === ball.owner);
      if (holder) { ball.x = holder.x + (holder.side === 1 ? 25 : -25); ball.y = holder.y - 28; }
      else ball.owner = null;
    }
    if (!ball.owner && Math.abs(ball.vx) + Math.abs(ball.vy) < 20) {
      const nearest = room.players.slice().sort((p, q) => Math.abs(p.x-ball.x)-Math.abs(q.x-ball.x))[0];
      if (nearest && Math.hypot(nearest.x-ball.x, nearest.y-28-ball.y) < 42) ball.owner = nearest.id;
    }
    for (const p of room.players) {
      const i = p.input || {};
      if (i.steal) {
        const other = room.players.find(q => q.id !== p.id);
        if (other && ball.owner === other.id && Math.hypot(p.x-other.x, p.y-other.y) < 58) ball.owner = p.id;
      }
      if (i.shoot && ball.owner === p.id && !p.didShoot) {
        p.didShoot = true;
        ball.owner = null;
        const hoopX = p.side === 1 ? 820 : 80;
        const direction = p.side === 1 ? 1 : -1;
        ball.vx = direction * 520;
        ball.vy = -570;
      }
      if (!i.shoot) p.didShoot = false;
    }
    if (!ball.owner) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      ball.vy += 900 * dt;
      ball.vx *= 0.995;
      if (ball.y > 440) { ball.y = 440; ball.vy *= -0.48; }
      // A made basket: ball crosses the opponent's hoop zone from above.
      if (ball.y < 205 && ((ball.x > 790 && ball.vx > 0) || (ball.x < 110 && ball.vx < 0))) {
        const shooter = ball.vx > 0 ? a : b;
        shooter.score += 2;
        io.to(room.code).emit("basket", { scorer: shooter.name, score: room.players.map(p => p.score) });
        ball.x = 450; ball.y = 300; ball.vx = 0; ball.vy = 0; ball.owner = null;
        a.x = 180; b.x = 720;
      }
      if (ball.x < -20 || ball.x > 920) { ball.x = 450; ball.y = 300; ball.vx = 0; ball.vy = 0; }
    }
    io.to(room.code).emit("state", {
      players: room.players.map(p => ({ name:p.name, side:p.side, x:p.x, y:p.y, score:p.score })),
      ball: { x:ball.x, y:ball.y, owner:ball.owner ? room.players.find(p=>p.id===ball.owner)?.side : null }
    });
  }
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hoop Duel running on http://localhost:${PORT}`));
