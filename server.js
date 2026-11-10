
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const rooms = new Map();

const COURT = {
  width: 900,
  height: 500,
  floor: 390,
  ballFloor: 362
};

const PLAYER_SPEED = 260;
const JUMP_POWER = 410;
const GRAVITY = 980;

const makeCode = () =>
  crypto.randomBytes(3).toString("hex").toUpperCase();

function cleanName(value) {
  return String(value || "Player")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 14) || "Player";
}

function createPlayer(socket, name, side) {
  return {
    id: socket.id,
    name: cleanName(name),
    side,
    x: side === 1 ? 180 : 720,
    y: COURT.floor,
    vx: 0,
    vy: 0,
    score: 0,
    ready: false,
    input: {},
    didShoot: false,
    lastStealAt: 0
  };
}

function createBall() {
  return {
    x: 450,
    y: COURT.ballFloor,
    vx: 0,
    vy: 0,
    owner: null,
    pickupLockoutUntil: 0
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({
      name: p.name,
      side: p.side,
      score: p.score,
      ready: p.ready
    })),
    started: room.started
  };
}

function emitState(room) {
  io.to(room.code).emit("state", {
    players: room.players.map(p => ({
      name: p.name,
      side: p.side,
      x: p.x,
      y: p.y,
      score: p.score
    })),
    ball: {
      x: room.ball.x,
      y: room.ball.y,
      owner: room.ball.owner
        ? room.players.find(p => p.id === room.ball.owner)?.side || null
        : null
    }
  });
}

// ROOMS AND CONNECTIONS

io.on("connection", socket => {

  socket.on("createRoom", ({ name } = {}) => {
    let code;

    do {
      code = makeCode();
    } while (rooms.has(code));

    const room = {
      code,
      players: [createPlayer(socket, name, 1)],
      ball: createBall(),
      started: false,
      lastTick: Date.now()
    };

    rooms.set(code, room);

    socket.join(code);
    socket.data.room = code;

    socket.emit("roomJoined", publicRoom(room));
  });

  socket.on("joinRoom", ({ code, name } = {}) => {
    code = String(code || "").trim().toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return socket.emit(
        "joinError",
        "Room not found. Check the code."
      );
    }

    if (room.players.length >= 2) {
      return socket.emit("joinError", "That room is full.");
    }

    const player = createPlayer(socket, name, 2);

    room.players.push(player);

    socket.join(code);
    socket.data.room = code;

    io.to(code).emit("roomJoined", publicRoom(room));
  });

  socket.on("ready", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.ready = true;

    if (
      room.players.length === 2 &&
      room.players.every(p => p.ready)
    ) {
      room.started = true;
      room.lastTick = Date.now();

      io.to(room.code).emit("gameStarted");
    }

    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  // PLAYER INPUT

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);

    if (!room || !room.started) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.input = {
      left: !!input.left,
      right: !!input.right,
      up: !!input.up,
      shoot: !!input.shoot,
      steal: !!input.steal
    };
  });

  // DISCONNECT

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);

    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      room.started = false;

      room.players[0].ready = false;
      room.ball = createBall();

      io.to(code).emit("opponentLeft");
      io.to(code).emit("roomUpdate", publicRoom(room));
    }
  });
});

// GAME PHYSICS

function movePlayer(player, dt) {
  const input = player.input;

  player.vx =
    ((input.right ? 1 : 0) - (input.left ? 1 : 0)) *
    PLAYER_SPEED;

  player.x += player.vx * dt;

  player.x = Math.max(
    35,
    Math.min(COURT.width - 35, player.x)
  );

  if (input.up && player.y >= COURT.floor) {
    player.vy = -JUMP_POWER;
  }

  player.vy += GRAVITY * dt;
  player.y += player.vy * dt;

  if (player.y >= COURT.floor) {
    player.y = COURT.floor;
    player.vy = 0;
  }
}

function followHolder(ball, holder) {
  const offset = holder.side === 1 ? 25 : -25;

  ball.x = holder.x + offset;
  ball.y = holder.y - 28;

  ball.vx = 0;
  ball.vy = 0;
}

function updateFreeBall(ball, dt) {
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  ball.vy += 900 * dt;

  ball.vx *= Math.pow(0.995, dt * 60);

  // Ground collision and bouncing.
  if (ball.y >= COURT.ballFloor) {
    ball.y = COURT.ballFloor;
    ball.vy *= -0.38;

    if (Math.abs(ball.vy) < 35) {
      ball.vy = 0;
    }

    if (Math.abs(ball.vx) < 12 && ball.vy === 0) {
      ball.vx = 0;
    }
  }
}

function tryPickupBall(room) {
  const ball = room.ball;

  if (ball.owner) return;
  if (Date.now() < ball.pickupLockoutUntil) return;

  const nearest = room.players
    .map(player => ({
      player,
      distance: Math.hypot(
        player.x - ball.x,
        (player.y - 28) - ball.y
      )
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  // Players can collect a ball when they get close enough.
  if (nearest && nearest.distance < 55) {
    ball.owner = nearest.player.id;
    ball.vx = 0;
    ball.vy = 0;
  }
}

function handleSteals(room) {
  const ball = room.ball;

  if (!ball.owner) return;

  const holder = room.players.find(p => p.id === ball.owner);
  if (!holder) {
    ball.owner = null;
    return;
  }

  const now = Date.now();

  for (const player of room.players) {
    if (player.id === holder.id) continue;

    if (!player.input.steal) continue;
    if (now - player.lastStealAt < 600) continue;

    const distance = Math.hypot(
      player.x - holder.x,
      player.y - holder.y
    );

    if (distance < 65) {
      ball.owner = player.id;
      player.lastStealAt = now;
      break;
    }
  }
}

function handleShooting(room) {
  const ball = room.ball;

  if (!ball.owner) return;

  const holder = room.players.find(p => p.id === ball.owner);
  if (!holder) return;

  if (!holder.input.shoot || holder.didShoot) return;

  holder.didShoot = true;

  // Release the ball.
  ball.owner = null;

  const direction = holder.side === 1 ? 1 : -1;

  ball.x = holder.x + direction * 25;
  ball.y = holder.y - 28;

  ball.vx = direction * 520;
  ball.vy = -570;

  // Prevent the shooter from instantly picking up their shot.
  ball.pickupLockoutUntil = Date.now() + 450;
}

function checkBasket(room) {
  const ball = room.ball;

  if (ball.y >= 205) return;

  let scorer = null;

  if (ball.x > 790 && ball.vx > 0) {
    scorer = room.players.find(p => p.side === 1);
  }

  if (ball.x < 110 && ball.vx < 0) {
    scorer = room.players.find(p => p.side === 2);
  }

  if (!scorer) return;

  scorer.score += 2;

  io.to(room.code).emit("basket", {
    scorer: scorer.name,
    score: room.players.map(p => p.score)
  });

  // Reset players and ball.
  room.players.forEach(p => {
    p.x = p.side === 1 ? 180 : 720;
    p.y = COURT.floor;
    p.vx = 0;
    p.vy = 0;
  });

  room.ball = createBall();
}

// MAIN GAME LOOP

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.started || room.players.length !== 2) continue;

    const dt = Math.min(
      (now - room.lastTick) / 1000,
      0.05
    );

    room.lastTick = now;

    const ball = room.ball;

    // Move both players.
    for (const player of room.players) {
      movePlayer(player, dt);
    }

    // Update ball position.
    if (ball.owner) {
      const holder = room.players.find(p => p.id === ball.owner);

      if (holder) {
        followHolder(ball, holder);
      } else {
        ball.owner = null;
      }
    }

    // Handle shooting before pickup so a released shot
    // cannot immediately be collected by the shooter.
    handleShooting(room);

    // Update free ball physics.
    if (!ball.owner) {
      updateFreeBall(ball, dt);

      // Try to collect the ball.
      tryPickupBall(room);
    }

    // Stealing.
    handleSteals(room);

    // Shooting key can be pressed again after release.
    for (const player of room.players) {
      if (!player.input.shoot) {
        player.didShoot = false;
      }
    }

    // Check scoring.
    checkBasket(room);

    // Keep clients synchronized.
    emitState(room);
  }
}, 1000 / 30);

server.listen(PORT, () => {
  console.log(`Hoop Duel running on port ${PORT}`);
});
