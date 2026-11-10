
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
const JUMP_POWER = 440;
const GRAVITY = 1100;
const BALL_GRAVITY = 900;

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
    previousInput: {},
    lastStealAt: 0,
    action: "idle",
    actionUntil: 0,
    dunking: false
  };
}

function createBall() {
  return {
    x: 450,
    y: COURT.ballFloor,
    vx: 0,
    vy: 0,
    owner: null,
    pickupLockoutUntil: 0,
    dunking: false,
    dunkTimer: 0
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
      vx: p.vx,
      vy: p.vy,
      score: p.score,
      action: p.action
    })),
    ball: {
      x: room.ball.x,
      y: room.ball.y,
      owner: room.ball.owner
        ? room.players.find(p => p.id === room.ball.owner)?.side || null
        : null,
      dunking: room.ball.dunking
    }
  });
}

// ROOMS

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
      return socket.emit("joinError", "Room not found. Check the code.");
    }

    if (room.players.length >= 2) {
      return socket.emit("joinError", "That room is full.");
    }

    room.players.push(createPlayer(socket, name, 2));
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

// PLAYER MOVEMENT

function movePlayer(player, dt) {
  const input = player.input;

  player.vx =
    ((input.right ? 1 : 0) - (input.left ? 1 : 0)) *
    PLAYER_SPEED;

  player.x += player.vx * dt;
  player.x = Math.max(30, Math.min(COURT.width - 30, player.x));

  // Jump only when the jump key is newly pressed.
  if (input.up && !player.previousInput.up && player.y >= COURT.floor) {
    player.vy = -JUMP_POWER;
    player.action = "jump";
  }

  player.vy += GRAVITY * dt;
  player.y += player.vy * dt;

  if (player.y >= COURT.floor) {
    player.y = COURT.floor;
    player.vy = 0;
    if (!player.dunking) player.action = "idle";
  }
}

function followHolder(ball, holder) {
  const direction = holder.side === 1 ? 1 : -1;
  ball.x = holder.x + direction * 25;
  ball.y = holder.y - 55;
  ball.vx = 0;
  ball.vy = 0;
}

function updateFreeBall(ball, dt) {
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
    ball.x = Math.max(15, Math.min(COURT.width - 15, ball.x));
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
        (player.y - 45) - ball.y
      )
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearest && nearest.distance < 48) {
    ball.owner = nearest.player.id;
    ball.vx = 0;
    ball.vy = 0;
  }
}

// SHOOTING AND DUNKING

function shootBall(room, player) {
  const ball = room.ball;
  if (ball.owner !== player.id) return;

  const direction = player.side === 1 ? 1 : -1;
  const hoopX = player.side === 1
    ? COURT.rightHoop
    : COURT.leftHoop;

  const distance = Math.abs(hoopX - player.x);
  const airborne = player.y < COURT.floor - 18;

  // A dunk is possible only close to the hoop while jumping.
  if (distance < 112 && airborne) {
    player.dunking = true;
    player.action = "dunk";
    player.actionUntil = Date.now() + 480;

    ball.owner = null;
    ball.dunking = true;
    ball.dunkTimer = 0.48;
    ball.x = hoopX - direction * 12;
    ball.y = COURT.hoopY - 42;
    ball.vx = direction * 80;
    ball.vy = 160;
    ball.pickupLockoutUntil = Date.now() + 1000;
    return;
  }

  // Normal shot: calculate a launch arc aimed at the hoop.
  ball.owner = null;

  ball.x = player.x + direction * 25;
  ball.y = player.y - 55;

  const horizontalDistance = Math.max(80, distance - 25);
  const horizontalSpeed = Math.max(
    390,
    Math.min(650, 350 + horizontalDistance * 0.32)
  );

  const flightTime = horizontalDistance / horizontalSpeed;
  const verticalDistance = COURT.hoopY - ball.y;

  ball.vx = direction * horizontalSpeed;
  ball.vy =
    (verticalDistance - 0.5 * BALL_GRAVITY * flightTime * flightTime) /
    flightTime;

  // A little extra lift makes shots visibly arc.
  ball.vy = Math.min(ball.vy, -300);

  ball.dunking = false;
  ball.pickupLockoutUntil = Date.now() + 650;
  player.action = "shoot";
  player.actionUntil = Date.now() + 350;
}

function handleShooting(room) {
  for (const player of room.players) {
    const pressed = player.input.shoot && !player.previousInput.shoot;

    if (pressed && room.ball.owner === player.id) {
      shootBall(room, player);
    }
  }
}

function handleDunk(room, dt) {
  const ball = room.ball;
  if (!ball.dunking) return;

  ball.dunkTimer -= dt;

  if (ball.dunkTimer <= 0) {
    const scorer = room.players.find(p => p.dunking);
    if (scorer) scoreBasket(room, scorer);

    ball.dunking = false;
    room.ball = createBall();
  }
}

// STEALING

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

    if (distance < 65) {
      ball.owner = player.id;
      player.lastStealAt = now;
      player.action = "steal";
      break;
    }
  }
}

// SCORING

function scoreBasket(room, scorer) {
  scorer.score += 2;

  io.to(room.code).emit("basket", {
    scorer: scorer.name,
    score: room.players.map(p => p.score)
  });

  room.players.forEach(p => {
    p.x = p.side === 1 ? 180 : 720;
    p.y = COURT.floor;
    p.vx = 0;
    p.vy = 0;
    p.dunking = false;
    p.action = "idle";
  });

  room.ball = createBall();
}

function checkBasket(room) {
  const ball = room.ball;
  if (ball.owner || ball.dunking) return;

  // A valid basket must pass through the hoop area while descending.
  if (ball.vy <= 0) return;
  if (ball.y < COURT.hoopY - 3 || ball.y > COURT.hoopY + 20) return;

  let scorer = null;

  if (Math.abs(ball.x - COURT.rightHoop) < 23 && ball.vx > 0) {
    scorer = room.players.find(p => p.side === 1);
  }

  if (Math.abs(ball.x - COURT.leftHoop) < 23 && ball.vx < 0) {
    scorer = room.players.find(p => p.side === 2);
  }

  if (scorer) scoreBasket(room, scorer);
}

// GAME LOOP

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (!room.started || room.players.length !== 2) continue;

    const dt = Math.min((now - room.lastTick) / 1000, 0.05);
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

      handleShooting(room);

      if (!room.ball.owner && !room.ball.dunking) {
        updateFreeBall(room.ball, dt);
        checkBasket(room);

        if (!room.ball.dunking) {
          tryPickupBall(room);
        }
      }

      handleSteals(room);
    }

    for (const player of room.players) {
      if (player.actionUntil < now && !player.dunking) {
        player.action = player.y < COURT.floor ? "jump" : "idle";
      }

      player.previousInput = { ...player.input };
    }

    emitState(room);
  }
}, 1000 / 30);

server.listen(PORT, () => {
  console.log(`Hoop Duel running on port ${PORT}`);
});
