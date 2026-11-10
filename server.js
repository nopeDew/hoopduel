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
  width: 1200,
  height: 600,
  floor: 470,
  ballFloor: 450,
  leftHoop: 90,
  rightHoop: 1110,
  hoopY: 175
};

const PLAYER_SPEED = 330;
const PLAYER_ACCEL = 2100;
const AIR_ACCEL = 1050;
const FRICTION = 2100;
const JUMP_POWER = 520;
const GRAVITY = 1250;
const BALL_GRAVITY = 820;
const TICK_RATE = 60;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function cleanName(value) {
  return String(value || "Player").replace(/[<>]/g, "").trim().slice(0, 14) || "Player";
}

function createPlayer(socket, name, side) {
  return {
    id: socket.id,
    name: cleanName(name),
    side,
    x: side === 1 ? 510 : 690,
    y: COURT.floor,
    vx: 0,
    vy: 0,
    score: 0,
    ready: false,
    input: {},
    previousInput: {},
    shootStartedAt: null,
    lastStealAt: 0,
    stunnedUntil: 0,
    action: "idle",
    actionUntil: 0,
    dunking: false
  };
}

function createBall() {
  return {
    x: 600,
    y: 330,
    vx: 0,
    vy: 0,
    owner: null,
    pickupLockoutUntil: 0,
    dunking: false,
    dunkTimer: 0,
    dunkScorerSide: null,
    shotBySide: null,
    previousY: 330
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
  const now = Date.now();

  io.to(room.code).emit("state", {
    players: room.players.map(p => ({
      name: p.name,
      side: p.side,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      score: p.score,
      action: p.action,
      stunned: p.stunnedUntil > now,
      charging: p.shootStartedAt !== null,
      charge: p.shootStartedAt === null
        ? 0
        : clamp((now - p.shootStartedAt) / 1000, 0, 1)
    })),
    ball: {
      x: room.ball.x,
      y: room.ball.y,
      owner: room.ball.owner
        ? room.players.find(p => p.id === room.ball.owner)?.side || null
        : null,
      dunking: room.ball.dunking
    },
    jumpBall: room.jumpBall
  });
}

function followHolder(ball, player) {
  const direction = player.side === 1 ? 1 : -1;
  ball.x = player.x + direction * 30;
  ball.y = player.y - 68;
  ball.vx = player.vx * 0.25;
  ball.vy = 0;
}

function movePlayer(p, dt) {
  const now = Date.now();

  if (p.stunnedUntil > now) {
    p.vx *= Math.pow(0.04, dt);
    p.vy += GRAVITY * dt;
    p.y += p.vy * dt;

    if (p.y >= COURT.floor) {
      p.y = COURT.floor;
      p.vy = 0;
    }

    p.action = "stunned";
    return;
  }

  if (p.action === "stunned") p.action = "idle";

  const direction = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
  const grounded = p.y >= COURT.floor - 0.1;
  const accel = grounded ? PLAYER_ACCEL : AIR_ACCEL;

  if (direction) {
    const target = direction * PLAYER_SPEED;
    p.vx += clamp(target - p.vx, -accel * dt, accel * dt);
  } else {
    const friction = (grounded ? FRICTION : FRICTION * 0.3) * dt;
    p.vx = Math.abs(p.vx) <= friction
      ? 0
      : p.vx - Math.sign(p.vx) * friction;
  }

  p.x = clamp(p.x + p.vx * dt, 35, COURT.width - 35);

  if (p.input.up && !p.previousInput.up && grounded) {
    p.vy = -JUMP_POWER;
    p.action = "jump";
  }

  p.vy += GRAVITY * dt;
  p.y += p.vy * dt;

  if (p.y >= COURT.floor) {
    p.y = COURT.floor;
    p.vy = 0;
    if (!p.dunking && p.action !== "shoot") p.action = "idle";
  } else if (!p.dunking && p.action !== "shoot") {
    p.action = "jump";
  }
}

function updateFreeBall(ball, dt) {
  ball.previousY = ball.y;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vy += BALL_GRAVITY * dt;
  ball.vx *= Math.pow(0.999, dt * 60);

  if (ball.y >= COURT.ballFloor) {
    ball.y = COURT.ballFloor;
    ball.vy *= -0.43;
    if (Math.abs(ball.vy) < 32) ball.vy = 0;
    if (Math.abs(ball.vx) < 8 && ball.vy === 0) ball.vx = 0;
  }

  if (ball.x < 20 || ball.x > COURT.width - 20) {
    ball.vx *= -0.55;
    ball.x = clamp(ball.x, 20, COURT.width - 20);
  }
}

function tryPickupBall(room) {
  const ball = room.ball;
  if (ball.owner || ball.dunking || Date.now() < ball.pickupLockoutUntil) return;

  const nearest = room.players.map(p => ({
    player: p,
    // Measure against the player's torso rather than their feet.
    distance: Math.hypot(p.x - ball.x, (p.y - 48) - ball.y)
  })).sort((a, b) => a.distance - b.distance)[0];

  const pickupRange = room.jumpBall ? 76 : 62;

  if (nearest && nearest.distance < pickupRange) {
    ball.owner = nearest.player.id;
    ball.vx = 0;
    ball.vy = 0;

    if (room.jumpBall) {
      room.jumpBall = false;
      io.to(room.code).emit("jumpBallWon", { player: nearest.player.name });
    }
  }
}

function shootBall(room, p, heldMilliseconds) {
  const ball = room.ball;
  if (ball.owner !== p.id) return;

  const direction = p.side === 1 ? 1 : -1;
  const hoopX = p.side === 1 ? COURT.rightHoop : COURT.leftHoop;
  const distance = Math.abs(hoopX - p.x);
  const airborne = p.y < COURT.floor - 24;

  if (distance < 125 && airborne) {
    p.dunking = true;
    p.action = "dunk";
    p.actionUntil = Date.now() + 550;

    ball.owner = null;
    ball.dunking = true;
    ball.dunkTimer = 0.55;
    ball.dunkScorerSide = p.side;
    ball.shotBySide = p.side;
    ball.x = hoopX - direction * 14;
    ball.y = COURT.hoopY - 38;
    ball.vx = direction * 70;
    ball.vy = 100;
    ball.pickupLockoutUntil = Date.now() + 1000;
    return;
  }

  const charge = clamp(heldMilliseconds / 1000, 0, 1.25);
  const timingQuality = clamp(1 - Math.abs(charge - 0.70) / 0.70, 0.12, 1);
  const distanceQuality = clamp(1 - Math.max(0, distance - 300) / 1100, 0.35, 1);

  const defender = room.players.find(other => other.id !== p.id);
  const defenderDistance = defender
    ? Math.hypot(defender.x - p.x, defender.y - p.y)
    : 999;

  const pressure = clamp((165 - defenderDistance) / 165, 0, 1);
  const quality = clamp(timingQuality * distanceQuality - pressure * 0.38, 0.08, 1);

  const missRange = 115 * (1 - quality) + 5;
  const targetX = hoopX + (Math.random() * 2 - 1) * missRange;
  const targetY = COURT.hoopY + (Math.random() * 2 - 1) * missRange * 0.5;

  ball.owner = null;
  ball.x = p.x + direction * 30;
  ball.y = p.y - 68;

  const horizontalDistance = Math.max(70, Math.abs(targetX - ball.x));
  const horizontalSpeed = clamp(410 + horizontalDistance * 0.25, 420, 720);
  const flightTime = horizontalDistance / horizontalSpeed;
  const verticalDistance = targetY - ball.y;

  ball.vx = direction * horizontalSpeed;
  ball.vy = (
    verticalDistance - 0.5 * BALL_GRAVITY * flightTime * flightTime
  ) / flightTime;
  ball.vy = Math.min(ball.vy, -270);
  ball.shotBySide = p.side;
  ball.pickupLockoutUntil = Date.now() + 420;

  p.action = "shoot";
  p.actionUntil = Date.now() + 350;

  io.to(room.code).emit("shotTaken", {
    player: p.name,
    quality: Math.round(quality * 100)
  });
}

function handleBlocks(room) {
  const ball = room.ball;
  if (ball.owner || !ball.shotBySide || ball.dunking) return;

  const defender = room.players.find(p => p.side !== ball.shotBySide);
  if (!defender || defender.y >= COURT.floor - 18) return;

  const nearBall =
    Math.abs(ball.x - defender.x) < 35 &&
    ball.y < defender.y - 25 &&
    ball.y > defender.y - 160;

  if (!nearBall) return;

  const direction = Math.sign(ball.vx) || 1;
  ball.vx = -direction * Math.max(170, Math.abs(ball.vx) * 0.5);
  ball.vy = -Math.max(200, Math.abs(ball.vy) * 0.35);
  ball.shotBySide = null;
  ball.pickupLockoutUntil = Date.now() + 180;

  defender.action = "block";
  defender.actionUntil = Date.now() + 350;
  io.to(room.code).emit("blocked", { player: defender.name });
}

function handleSteals(room) {
  const ball = room.ball;
  const now = Date.now();

  for (const player of room.players) {
    if (!player.input.steal || now - player.lastStealAt < 650) continue;

    const opponent = room.players.find(p => p.id !== player.id);
    if (!opponent || opponent.stunnedUntil > now) continue;

    const distance = Math.hypot(player.x - opponent.x, player.y - opponent.y);
    if (distance > 72) continue;

    player.lastStealAt = now;

    if (ball.owner === opponent.id) {
      ball.owner = player.id;
      player.action = "steal";
      io.to(room.code).emit("stolen", { player: player.name });
    } else if (ball.owner !== player.id) {
      opponent.stunnedUntil = now + 1500;
      opponent.vx = 0;
      opponent.vy = 0;
      opponent.action = "stunned";
      opponent.actionUntil = now + 1500;
      io.to(room.code).emit("stunned", { player: opponent.name });
    }
  }
}

function givePossession(room, player) {
  room.players.forEach(p => {
    p.x = p.side === 1 ? 240 : 960;
    p.y = COURT.floor;
    p.vx = 0;
    p.vy = 0;
    p.dunking = false;
    p.action = "idle";
    p.shootStartedAt = null;
    p.input.shoot = false;
    p.previousInput.shoot = false;
  });

  room.ball = createBall();
  room.ball.owner = player.id;
  followHolder(room.ball, player);
  room.jumpBall = false;
}

function scoreBasket(room, scorer) {
  scorer.score += 2;
  io.to(room.code).emit("basket", {
    scorer: scorer.name,
    score: room.players.map(p => p.score)
  });

  const receiver = room.players.find(p => p.id !== scorer.id);
  if (receiver) givePossession(room, receiver);
}

function checkBasket(room) {
  const ball = room.ball;
  if (ball.owner || ball.dunking || !ball.shotBySide || ball.vy <= 0) return;

  if (!(ball.previousY <= COURT.hoopY && ball.y >= COURT.hoopY)) return;

  let scorer = null;

  if (
    Math.abs(ball.x - COURT.rightHoop) < 24 &&
    ball.vx > 0 &&
    ball.shotBySide === 1
  ) scorer = room.players.find(p => p.side === 1);

  if (
    Math.abs(ball.x - COURT.leftHoop) < 24 &&
    ball.vx < 0 &&
    ball.shotBySide === 2
  ) scorer = room.players.find(p => p.side === 2);

  if (scorer) scoreBasket(room, scorer);
}

function handleDunk(room, dt) {
  room.ball.dunkTimer -= dt;
  if (room.ball.dunkTimer > 0) return;

  const scorer = room.players.find(p => p.side === room.ball.dunkScorerSide);
  if (scorer) scoreBasket(room, scorer);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}) => {
    let code;
    do { code = makeCode(); } while (rooms.has(code));

    const room = {
      code,
      players: [createPlayer(socket, name, 1)],
      ball: createBall(),
      started: false,
      jumpBall: true,
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

    if (!room) return socket.emit("joinError", "Room not found. Check the code.");
    if (room.players.length >= 2) return socket.emit("joinError", "That room is full.");

    room.players.push(createPlayer(socket, name, 2));
    socket.join(code);
    socket.data.room = code;

    io.to(code).emit("roomUpdate", publicRoom(room));
    socket.emit("roomJoined", publicRoom(room));
  });

  socket.on("ready", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = true;

    if (room.players.length === 2 && room.players.every(p => p.ready)) {
      room.started = true;
      room.jumpBall = true;
      room.lastTick = Date.now();

      room.players[0].x = 510;
      room.players[1].x = 690;

      room.players.forEach(p => {
        p.y = COURT.floor;
        p.vx = 0;
        p.vy = 0;
      });

      room.ball = createBall();
      room.ball.x = 600;
      room.ball.y = 300;
      room.ball.vy = -240;
      room.ball.pickupLockoutUntil = Date.now() + 80;

      io.to(room.code).emit("gameStarted");
    }

    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;

    const p = room.players.find(player => player.id === socket.id);
    if (!p) return;

    const next = {
      left: !!input.left,
      right: !!input.right,
      up: !!input.up,
      shoot: !!input.shoot,
      steal: !!input.steal
    };

    if (next.shoot && !p.input.shoot && room.ball.owner === p.id) {
      p.shootStartedAt = Date.now();
    }

    if (!next.shoot && p.input.shoot) {
      if (p.shootStartedAt !== null && room.ball.owner === p.id) {
        shootBall(room, p, Date.now() - p.shootStartedAt);
      }
      p.shootStartedAt = null;
    }

    p.input = next;
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (!room.players.length) {
      rooms.delete(room.code);
    } else {
      room.started = false;
      room.jumpBall = true;
      room.players[0].ready = false;
      room.ball = createBall();
      io.to(room.code).emit("opponentLeft");
      io.to(room.code).emit("roomUpdate", publicRoom(room));
    }
  });
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.started || room.players.length !== 2) continue;

    const dt = Math.min((now - room.lastTick) / 1000, 0.035);
    room.lastTick = now;

    for (const player of room.players) movePlayer(player, dt);

    if (room.ball.dunking) {
      handleDunk(room, dt);
    } else {
      if (room.ball.owner) {
        const holder = room.players.find(p => p.id === room.ball.owner);
        if (holder) followHolder(room.ball, holder);
        else room.ball.owner = null;
      }

      if (!room.ball.owner) {
        updateFreeBall(room.ball, dt);
        handleBlocks(room);
        checkBasket(room);
        if (!room.ball.dunking && !room.ball.owner) tryPickupBall(room);
      }

      handleSteals(room);
    }

    for (const p of room.players) {
      if (p.actionUntil < now && p.stunnedUntil <= now && !p.dunking) {
        p.action = p.y < COURT.floor ? "jump" : "idle";
      }
      p.previousInput = { ...p.input };
    }

    emitState(room);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Hoop Duel running on port ${PORT}`));
