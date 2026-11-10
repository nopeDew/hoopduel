
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
  ballFloor: 373,
  leftHoop: 80,
  rightHoop: 820,
  hoopY: 205
};

const PLAYER_SPEED = 280;
const PLAYER_ACCEL = 1700;
const AIR_ACCEL = 950;
const FRICTION = 1900;
const JUMP_POWER = 465;
const GRAVITY = 1100;
const BALL_GRAVITY = 900;
const TICK_RATE = 60;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

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
    x: side === 1 ? 350 : 550,
    y: COURT.floor,
    vx: 0,
    vy: 0,
    score: 0,
    ready: false,
    input: {},
    previousInput: {},
    shootStartedAt: null,
    lastStealAt: 0,
    action: "idle",
    actionUntil: 0,
    dunking: false
  };
}

function createBall() {
  return {
    x: 450,
    y: 373,
    vx: 0,
    vy: 0,
    owner: null,
    pickupLockoutUntil: 0,
    dunking: false,
    dunkTimer: 0,
    dunkScorerSide: null,
    shotBySide: null,
    previousY: 373
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

function followHolder(ball, holder) {
  const direction = holder.side === 1 ? 1 : -1;
  ball.x = holder.x + direction * 25;
  ball.y = holder.y - 58;
  ball.vx = 0;
  ball.vy = 0;
}

function movePlayer(player, dt) {
  const input = player.input;
  const direction = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const grounded = player.y >= COURT.floor - 0.1;
  const acceleration = grounded ? PLAYER_ACCEL : AIR_ACCEL;

  if (direction !== 0) {
    const target = direction * PLAYER_SPEED;
    const difference = target - player.vx;
    player.vx += clamp(difference, -acceleration * dt, acceleration * dt);
  } else {
    const amount = (grounded ? FRICTION : FRICTION * 0.35) * dt;
    player.vx = Math.abs(player.vx) <= amount
      ? 0
      : player.vx - Math.sign(player.vx) * amount;
  }

  player.x += player.vx * dt;
  player.x = clamp(player.x, 30, COURT.width - 30);

  if (input.up && !player.previousInput.up && grounded) {
    player.vy = -JUMP_POWER;
    player.action = "jump";
  }

  player.vy += GRAVITY * dt;
  player.y += player.vy * dt;

  if (player.y >= COURT.floor) {
    player.y = COURT.floor;
    player.vy = 0;

    if (!player.dunking && player.action !== "shoot") {
      player.action = "idle";
    }
  } else if (!player.dunking && player.action !== "shoot") {
    player.action = "jump";
  }
}

function updateFreeBall(ball, dt) {
  ball.previousY = ball.y;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vy += BALL_GRAVITY * dt;
  ball.vx *= Math.pow(0.998, dt * 60);

  if (ball.y >= COURT.ballFloor) {
    ball.y = COURT.ballFloor;
    ball.vy *= -0.42;

    if (Math.abs(ball.vy) < 35) ball.vy = 0;
    if (Math.abs(ball.vx) < 10 && ball.vy === 0) ball.vx = 0;
  }

  if (ball.x < 15 || ball.x > COURT.width - 15) {
    ball.vx *= -0.55;
    ball.x = clamp(ball.x, 15, COURT.width - 15);
  }
}

function tryPickupBall(room) {
  const ball = room.ball;

  if (ball.owner || ball.dunking) return;
  if (Date.now() < ball.pickupLockoutUntil) return;

  const nearest = room.players
    .map(player => ({
      player,
      distance: Math.hypot(
        player.x - ball.x,
        (player.y - 85) - ball.y
      )
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearest && nearest.distance < 47) {
    ball.owner = nearest.player.id;
    ball.vx = 0;
    ball.vy = 0;

    if (room.jumpBall) {
      room.jumpBall = false;
      io.to(room.code).emit("jumpBallWon", {
        player: nearest.player.name
      });
    }
  }
}

function shootBall(room, player, heldMilliseconds) {
  const ball = room.ball;
  if (ball.owner !== player.id) return;

  const direction = player.side === 1 ? 1 : -1;
  const hoopX = player.side === 1
    ? COURT.rightHoop
    : COURT.leftHoop;

  const distance = Math.abs(hoopX - player.x);
  const airborne = player.y < COURT.floor - 22;

  if (distance < 105 && airborne) {
    player.dunking = true;
    player.action = "dunk";
    player.actionUntil = Date.now() + 520;

    ball.owner = null;
    ball.dunking = true;
    ball.dunkTimer = 0.52;
    ball.dunkScorerSide = player.side;
    ball.shotBySide = player.side;
    ball.x = hoopX - direction * 12;
    ball.y = COURT.hoopY - 38;
    ball.vx = direction * 65;
    ball.vy = 100;
    ball.pickupLockoutUntil = Date.now() + 1000;
    return;
  }

  const charge = clamp(heldMilliseconds / 1000, 0, 1.25);
  const timingQuality = clamp(
    1 - Math.abs(charge - 0.70) / 0.70,
    0.12,
    1
  );

  const distanceQuality = clamp(
    1 - Math.max(0, distance - 250) / 1050,
    0.35,
    1
  );

  const defender = room.players.find(p => p.id !== player.id);
  const defenderDistance = defender
    ? Math.hypot(defender.x - player.x, defender.y - player.y)
    : 999;

  const pressure = clamp((150 - defenderDistance) / 150, 0, 1);
  const pressurePenalty = pressure * 0.38;

  const quality = clamp(
    timingQuality * distanceQuality - pressurePenalty,
    0.08,
    1
  );

  const missRange = 105 * (1 - quality) + 5;
  const horizontalMiss = (Math.random() * 2 - 1) * missRange;
  const verticalMiss = (Math.random() * 2 - 1) * missRange * 0.55;

  const targetX = hoopX + horizontalMiss;
  const targetY = COURT.hoopY + verticalMiss;

  ball.owner = null;
  ball.x = player.x + direction * 25;
  ball.y = player.y - 58;

  const horizontalDistance = Math.max(70, Math.abs(targetX - ball.x));
  const horizontalSpeed = clamp(
    370 + horizontalDistance * 0.28,
    390,
    680
  );

  const flightTime = horizontalDistance / horizontalSpeed;
  const verticalDistance = targetY - ball.y;

  ball.vx = direction * horizontalSpeed;
  ball.vy = (
    verticalDistance -
    0.5 * BALL_GRAVITY * flightTime * flightTime
  ) / flightTime;

  ball.vy = Math.min(ball.vy, -260);
  ball.shotBySide = player.side;
  ball.pickupLockoutUntil = Date.now() + 450;

  player.action = "shoot";
  player.actionUntil = Date.now() + 350;

  io.to(room.code).emit("shotTaken", {
    player: player.name,
    quality: Math.round(quality * 100)
  });
}

function handleBlocks(room) {
  const ball = room.ball;
  if (ball.owner || !ball.shotBySide || ball.dunking) return;

  const defender = room.players.find(p => p.side !== ball.shotBySide);
  if (!defender) return;

  const airborne = defender.y < COURT.floor - 18;
  if (!airborne) return;

  const nearPlayer =
    Math.abs(ball.x - defender.x) < 29 &&
    ball.y < defender.y - 32 &&
    ball.y > defender.y - 145;

  if (!nearPlayer) return;

  const shotDirection = Math.sign(ball.vx) || 1;

  ball.vx = -shotDirection * Math.max(150, Math.abs(ball.vx) * 0.48);
  ball.vy = -Math.max(190, Math.abs(ball.vy) * 0.35);
  ball.shotBySide = null;
  ball.pickupLockoutUntil = Date.now() + 180;

  defender.action = "block";
  defender.actionUntil = Date.now() + 350;

  io.to(room.code).emit("blocked", {
    player: defender.name
  });
}

function handleSteals(room) {
  const ball = room.ball;
  if (!ball.owner || ball.dunking) return;

  const holder = room.players.find(p => p.id === ball.owner);
  if (!holder) {
    ball.owner = null;
    return;
  }

  const now = Date.now();

  for (const player of room.players) {
    if (player.id === holder.id) continue;
    if (!player.input.steal) continue;
    if (now - player.lastStealAt < 650) continue;

    const distance = Math.hypot(
      player.x - holder.x,
      player.y - holder.y
    );

    if (distance < 62) {
      ball.owner = player.id;
      player.lastStealAt = now;
      player.action = "steal";
      break;
    }
  }
}

function givePossession(room, player) {
  room.players.forEach(p => {
    p.x = p.side === 1 ? 180 : 720;
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
  if (ball.owner || ball.dunking || !ball.shotBySide) return;
  if (ball.vy <= 0) return;

  const crossedRim =
    ball.previousY <= COURT.hoopY &&
    ball.y >= COURT.hoopY;

  if (!crossedRim) return;

  let scorer = null;

  if (
    Math.abs(ball.x - COURT.rightHoop) < 22 &&
    ball.vx > 0 &&
    ball.shotBySide === 1
  ) {
    scorer = room.players.find(p => p.side === 1);
  }

  if (
    Math.abs(ball.x - COURT.leftHoop) < 22 &&
    ball.vx < 0 &&
    ball.shotBySide === 2
  ) {
    scorer = room.players.find(p => p.side === 2);
  }

  if (scorer) scoreBasket(room, scorer);
}

function handleDunk(room, dt) {
  const ball = room.ball;
  if (!ball.dunking) return;

  ball.dunkTimer -= dt;

  if (ball.dunkTimer <= 0) {
    const scorer = room.players.find(
      p => p.side === ball.dunkScorerSide
    );

    if (scorer) scoreBasket(room, scorer);
  }
}

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

    if (!room) {
      return socket.emit("joinError", "Room not found. Check the code.");
    }

    if (room.players.length >= 2) {
      return socket.emit("joinError", "That room is full.");
    }

    room.players.push(createPlayer(socket, name, 2));
    socket.join(code);
    socket.data.room = code;

    // Update the room for both players, but identify the joining player
    // only to their own socket.
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

      room.players[0].x = 350;
      room.players[1].x = 550;

      room.players.forEach(p => {
        p.y = COURT.floor;
        p.vx = 0;
        p.vy = 0;
      });

      room.ball = createBall();
      room.ball.y = 270;
      room.ball.vy = -250;
      room.ball.pickupLockoutUntil = Date.now() + 100;

      io.to(room.code).emit("gameStarted");
    }

    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const nextInput = {
      left: !!input.left,
      right: !!input.right,
      up: !!input.up,
      shoot: !!input.shoot,
      steal: !!input.steal
    };

    if (nextInput.shoot && !player.input.shoot) {
      if (room.ball.owner === player.id) {
        player.shootStartedAt = Date.now();
      }
    }

    if (!nextInput.shoot && player.input.shoot) {
      if (
        player.shootStartedAt !== null &&
        room.ball.owner === player.id
      ) {
        shootBall(
          room,
          player,
          Date.now() - player.shootStartedAt
        );
      }

      player.shootStartedAt = null;
    }

    player.input = nextInput;
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      room.started = false;
      room.jumpBall = true;
      room.players[0].ready = false;
      room.ball = createBall();

      io.to(code).emit("opponentLeft");
      io.to(code).emit("roomUpdate", publicRoom(room));
    }
  });
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.started || room.players.length !== 2) continue;

    const dt = Math.min((now - room.lastTick) / 1000, 0.035);
    room.lastTick = now;

    for (const player of room.players) {
      movePlayer(player, dt);
    }

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

        if (!room.ball.dunking && !room.ball.owner) {
          tryPickupBall(room);
        }
      }

      handleSteals(room);
    }

    for (const player of room.players) {
      if (player.actionUntil < now && !player.dunking) {
        if (player.y < COURT.floor) {
          player.action = "jump";
        } else if (player.action !== "idle") {
          player.action = "idle";
        }
      }

      player.previousInput = { ...player.input };
    }

    emitState(room);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Hoop Duel running on port ${PORT}`);
});
