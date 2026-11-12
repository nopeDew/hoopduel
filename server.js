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
  leftHoop: 82,
  rightHoop: 1118,
  hoopY: 175
};

const PLAYER_SPEED = 340;
const PLAYER_ACCEL = 5200;
const AIR_ACCEL = 1750;
const FRICTION = 6800;
const AIR_FRICTION = 2100;
const JUMP_POWER = 665;
const GRAVITY = 1250;
const BALL_GRAVITY = 820;

const JUMP_BALL_TOSS_SPEED = 480;

const DASH_SPEED = 850;
const DASH_DURATION_MS = 180;
const DASH_COOLDOWN_MS = 1100;

const STEAL_RANGE = 38;
const LOOSE_BALL_STUN_RANGE = 52;
const LOOSE_BALL_STUN_DURATION_MS = 700;
const STEAL_COOLDOWN_MS = 1300;

const SHOT_CHARGE_RATE = 1.5;
const ABILITY_COOLDOWN_MS = 14000;

const CHARACTERS = {
  lebron: {
    name: "LeBron James", number: "23", icon: "🛡️",
    ability: "Chase Down", abilityId: "chasedown"
  },
  steph: {
    name: "Stephen Curry", number: "30", icon: "🎯",
    ability: "Range Extender", abilityId: "range"
  },
  jordan: {
    name: "Michael Jordan", number: "23", icon: "⚡",
    ability: "First Step", abilityId: "firststep"
  },
  shaq: {
    name: "Shaquille O'Neal", number: "34", icon: "💪",
    ability: "Diesel Mode", abilityId: "diesel"
  },
  kareem: {
    name: "Kareem Abdul-Jabbar", number: "33", icon: "🏀",
    ability: "Skyhook", abilityId: "skyhook"
  }
};

const DEFAULT_CHARACTER_ORDER = ["lebron", "steph", "jordan", "shaq", "kareem"];

const TICK_RATE = 60;
const SNAPSHOT_EVERY = 2;

const REGULATION_MS = 60000;
const OVERTIME_MS = 15000;

const GREEN_MIN = 0.66;
const GREEN_MAX = 0.78;
const PERFECT_RELEASE = 0.72;
const THREE_POINT_DISTANCE = 330;

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
    characterId: side === 1 ? "lebron" : "steph",
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
    lastPumpFakeAt: 0,
    lastDashAt: 0,
    dashUntil: 0,
    dashDirection: 0,
    abilityUntil: 0,
    abilityCooldownUntil: 0,
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
    shotPoints: 2,
    pendingScore: null,
    previousX: 600,
    previousY: 330
  };
}

function formatTime(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function getClock(room, now = Date.now()) {
  const countdown = room.jumpBallStartsAt && now < room.jumpBallStartsAt
    ? Math.ceil((room.jumpBallStartsAt - now) / 1000)
    : 0;

  const remainingMs = Math.max(0, room.periodEndsAt - now);

  return {
    remainingMs,
    overtime: room.overtime,
    jumpBallCountdown: countdown,
    label: countdown > 0
      ? "TIP-OFF"
      : room.overtime
        ? `OT ${room.overtime} · ${formatTime(remainingMs)}`
        : formatTime(remainingMs),
    gameOver: !!room.gameOver
  };
}

function characterFor(player) {
  return CHARACTERS[player.characterId] || CHARACTERS.lebron;
}

function firstAvailableCharacter(room) {
  const taken = new Set(room.players.map(p => p.characterId));
  return DEFAULT_CHARACTER_ORDER.find(id => !taken.has(id)) || "lebron";
}

function publicRoom(room, mySide = null) {
  return {
    code: room.code,
    players: room.players.map(p => {
      const character = characterFor(p);
      return {
        name: p.name,
        side: p.side,
        score: p.score,
        ready: p.ready,
        characterId: p.characterId,
        characterName: character.name,
        jerseyNumber: character.number,
        ability: character.ability
      };
    }),
    characters: Object.entries(CHARACTERS).map(([id, character]) => ({
      id,
      ...character
    })),
    started: room.started,
    mySide
  };
}

function emitState(room, now = Date.now()) {
  const clock = getClock(room, now);

  // Keep the meter at 0% during the tip-off countdown.
  // Its 14-second recharge begins when the ball is tossed into play.
  const abilityClockNow = Math.max(now, room.jumpBallStartsAt || now);

  for (const viewer of room.players) {
    io.to(viewer.id).emit("state", {
      players: room.players.map(p => {
        const isViewer = p.id === viewer.id;
        const character = characterFor(p);
        const charging = p.shootStartedAt !== null;
        const charge = charging
          ? clamp(((now - p.shootStartedAt) / 1000) * SHOT_CHARGE_RATE, 0, 1.2)
          : 0;

        return {
          name: p.name,
          side: p.side,
          characterId: p.characterId,
          characterName: character.name,
          jerseyNumber: character.number,
          ability: character.ability,
          abilityIcon: character.icon,
          abilityActive: p.abilityUntil > now,
          abilityRemainingMs: Math.max(0, p.abilityUntil - now),
          abilityCooldownMs: Math.max(0, p.abilityCooldownUntil - abilityClockNow),
          abilityFill: clamp(
            1 - Math.max(0, p.abilityCooldownUntil - abilityClockNow) / ABILITY_COOLDOWN_MS,
            0,
            1
          ),
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          score: p.score,
          action: p.action,
          stunned: p.stunnedUntil > now,
          charging,
          showShotMeter: isViewer && charging,
          charge: isViewer ? charge : 0
        };
      }),
      ball: {
        x: room.ball.x,
        y: room.ball.y,
        owner: room.ball.owner
          ? room.players.find(p => p.id === room.ball.owner)?.side || null
          : null,
        dunking: room.ball.dunking,
        pendingScore: !!room.ball.pendingScore
      },
      clock,
      gameOver: !!room.gameOver
    });
  }
}

function startGame(room) {
  const now = Date.now();

  room.started = true;
  room.gameOver = false;
  room.overtime = 0;
  room.jumpBallStartsAt = now + 3000;
  room.jumpBallTossStarted = false;
  room.periodEndsAt = room.jumpBallStartsAt + REGULATION_MS;
  room.lastTick = now;
  room.snapshotCounter = 0;

  room.players.forEach((p, index) => {
    p.score = 0;
    p.ready = false;
    p.x = index === 0 ? 530 : 670;
    p.y = COURT.floor;
    p.vx = 0;
    p.vy = 0;
    p.input = {};
    p.previousInput = {};
    p.shootStartedAt = null;
    p.dunking = false;
    p.action = "idle";
    p.actionUntil = 0;
    p.stunnedUntil = 0;
    p.lastStealAt = 0;
    p.lastDashAt = 0;
    p.dashUntil = 0;
    p.dashDirection = 0;
    p.abilityUntil = 0;

    // Neither player starts with a ready ability.
    // The cooldown starts when the jump ball begins.
    p.abilityCooldownUntil = room.jumpBallStartsAt + ABILITY_COOLDOWN_MS;
  });

  room.ball = createBall();
  room.ball.x = 600;
  room.ball.y = 350;
  room.ball.previousX = 600;
  room.ball.previousY = 350;
  room.ball.vx = 0;
  room.ball.vy = 0;

  io.to(room.code).emit("gameStarted");
  emitState(room, now);
}

function followHolder(ball, player) {
  const direction = player.side === 1 ? 1 : -1;

  if (player.action === "pumpFake" || player.shootStartedAt !== null) {
    ball.x = player.x + direction * 15;
    ball.y = player.y - 190;
  } else {
    ball.x = player.x + direction * 30;
    ball.y = player.y - 68;
  }

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

  const direction =
    (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);

  const grounded = p.y >= COURT.floor - 0.1;
  const activeSpeedBoost = p.characterId === "jordan" && p.abilityUntil > now ? 1.38 : 1;
  const speed = PLAYER_SPEED * activeSpeedBoost;
  const acceleration = (grounded ? PLAYER_ACCEL : AIR_ACCEL) * activeSpeedBoost;

  if (p.dashUntil > now) {
    p.vx = p.dashDirection * DASH_SPEED;
  } else if (direction) {
    const target = direction * speed;
    p.vx += clamp(
      target - p.vx,
      -acceleration * dt,
      acceleration * dt
    );
  } else {
    const friction = (grounded ? FRICTION : AIR_FRICTION) * dt;

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

    if (
      !p.dunking &&
      p.action !== "shoot" &&
      p.action !== "pumpFake"
    ) {
      p.action = "idle";
    }
  } else if (
    !p.dunking &&
    p.action !== "shoot" &&
    p.action !== "pumpFake"
  ) {
    p.action = "jump";
  }
}

function updateFreeBall(ball, dt) {
  ball.previousX = ball.x;
  ball.previousY = ball.y;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vy += BALL_GRAVITY * dt;
  ball.vx *= Math.pow(0.999, dt * 60);

  if (ball.y >= COURT.ballFloor) {
    ball.y = COURT.ballFloor;

    if (ball.vy > 65) {
      ball.vy = -ball.vy * 0.43;
    } else {
      ball.vy = 0;
      ball.vx *= Math.pow(0.93, dt * 60);
      if (Math.abs(ball.vx) < 18) ball.vx = 0;
    }
  }

  if (ball.x < 20 || ball.x > COURT.width - 20) {
    ball.vx *= -0.55;
    ball.x = clamp(ball.x, 20, COURT.width - 20);
  }
}

function tryPickupBall(room) {
  const ball = room.ball;

  if (
    ball.owner ||
    ball.dunking ||
    ball.pendingScore ||
    Date.now() < ball.pickupLockoutUntil
  ) return;

  const nearest = room.players.map(player => ({
    player,
    distance: Math.hypot(
      player.x - ball.x,
      (player.y - 35) - ball.y
    )
  })).sort((a, b) => a.distance - b.distance)[0];

  if (nearest && nearest.distance < 88) {
    ball.owner = nearest.player.id;
    ball.vx = 0;
    ball.vy = 0;
  }
}

function shootBall(room, p, heldMilliseconds) {
  const ball = room.ball;
  if (ball.owner !== p.id) return;

  const direction = p.side === 1 ? 1 : -1;
  const hoopX = p.side === 1
    ? COURT.rightHoop
    : COURT.leftHoop;

  const distance = Math.abs(hoopX - p.x);
  const airborne = p.y < COURT.floor - 24;

  const dieselActive = p.characterId === "shaq" && p.abilityUntil > Date.now();
  const dunkRange = 125 + (dieselActive ? 85 : 0);

  if (distance < dunkRange && airborne) {
    p.dunking = true;
    p.action = "dunk";
    p.actionUntil = Date.now() + 450;

    ball.owner = null;
    ball.dunking = true;
    ball.dunkTimer = 0.38;
    ball.dunkScorerSide = p.side;
    ball.shotBySide = p.side;
    ball.shotPoints = 2;
    ball.x = hoopX - direction * 14;
    ball.y = COURT.hoopY - 38;
    ball.vx = 0;
    ball.vy = 100;
    ball.pickupLockoutUntil = Date.now() + 1500;
    return;
  }

  const charge = clamp((heldMilliseconds / 1000) * SHOT_CHARGE_RATE, 0, 1.2);
  const greenRelease = charge >= GREEN_MIN && charge <= GREEN_MAX;
  const stephRangeActive = p.characterId === "steph" && p.abilityUntil > Date.now();
  const kareemSkyhookActive = p.characterId === "kareem" && p.abilityUntil > Date.now();

  let timingQuality = greenRelease
    ? 1
    : clamp(
        1 - Math.abs(charge - PERFECT_RELEASE) / 0.78,
        0.08,
        0.92
      );

  if (kareemSkyhookActive) {
    timingQuality = clamp(timingQuality + 0.16, 0.08, 1);
  }

  const effectiveDistance = stephRangeActive ? distance * 0.72 : distance;
  const distanceQuality = clamp(
    1 - Math.max(0, effectiveDistance - 300) / 1100,
    0.35,
    1
  );

  const defender = room.players.find(other => other.id !== p.id);

  const defenderDistance = defender
    ? Math.hypot(defender.x - p.x, defender.y - p.y)
    : 999;

  const pressure = clamp((165 - defenderDistance) / 165, 0, 1);
  const pressurePenalty = kareemSkyhookActive ? 0.12 : 0.34;
  const quality = clamp(
    timingQuality * distanceQuality - pressure * pressurePenalty,
    0.08,
    1
  );

  const points = distance >= THREE_POINT_DISTANCE ? 3 : 2;
  const missRange = 125 * (1 - quality) + 4;

  const targetX = hoopX + (Math.random() * 2 - 1) * missRange;
  const targetY =
    COURT.hoopY + (Math.random() * 2 - 1) * missRange * 0.45;

  ball.owner = null;
  ball.x = p.x + direction * 30;
  ball.y = p.y - 68;

  const horizontalDistance = Math.max(
    70,
    Math.abs(targetX - ball.x)
  );

  const horizontalSpeed = clamp(
    420 + horizontalDistance * 0.25,
    430,
    740
  );

  const flightTime = horizontalDistance / horizontalSpeed;
  const verticalDistance = targetY - ball.y;

  ball.vx = direction * horizontalSpeed;
  ball.vy = (
    verticalDistance -
    0.5 * BALL_GRAVITY * flightTime * flightTime
  ) / flightTime;

  ball.vy = Math.min(ball.vy, -270);
  ball.shotBySide = p.side;
  ball.shotPoints = points;
  ball.pickupLockoutUntil = Date.now() + 420;

  p.action = "shoot";
  p.actionUntil = Date.now() + 350;

  io.to(room.code).emit("shotTaken", {
    player: p.name,
    quality: Math.round(quality * 100),
    green: greenRelease,
    points
  });
}

function handleBlocks(room) {
  const ball = room.ball;

  if (
    ball.owner ||
    !ball.shotBySide ||
    ball.dunking ||
    ball.pendingScore
  ) return;

  const defender = room.players.find(
    p => p.side !== ball.shotBySide
  );

  if (!defender || defender.y >= COURT.floor - 18) return;

  const lebronBoost = defender.characterId === "lebron" && defender.abilityUntil > Date.now();
  const horizontalReach = lebronBoost ? 52 : 35;
  const verticalReach = lebronBoost ? 215 : 160;
  const nearBall =
    Math.abs(ball.x - defender.x) < horizontalReach &&
    ball.y < defender.y - 25 &&
    ball.y > defender.y - verticalReach;

  if (!nearBall) return;

  const direction = Math.sign(ball.vx) || 1;

  ball.vx = -direction * Math.max(170, Math.abs(ball.vx) * 0.5);
  ball.vy = -Math.max(200, Math.abs(ball.vy) * 0.35);
  ball.shotBySide = null;
  ball.pickupLockoutUntil = Date.now() + 180;

  defender.action = "block";
  defender.actionUntil = Date.now() + 350;

  io.to(room.code).emit("blocked", {
    player: defender.name
  });
}

function attemptSteal(room, player, now = Date.now()) {
  const ball = room.ball;
  const opponent = room.players.find(p => p.id !== player.id);

  if (
    !opponent ||
    ball.dunking ||
    ball.pendingScore ||
    opponent.stunnedUntil > now ||
    player.stunnedUntil > now ||
    player.dunking ||
    player.shootStartedAt !== null
  ) return;

  if (now - player.lastStealAt < STEAL_COOLDOWN_MS) return;

  player.lastStealAt = now;

  const horizontalDistance = Math.abs(player.x - opponent.x);
  const verticalDistance = Math.abs(player.y - opponent.y);

  // With a loose ball, Shift briefly stuns a nearby opponent.
  // It does not automatically steal or pick up the ball.
  if (!ball.owner) {
    if (
      horizontalDistance > LOOSE_BALL_STUN_RANGE ||
      verticalDistance > 42
    ) return;

    opponent.stunnedUntil = now + LOOSE_BALL_STUN_DURATION_MS;
    opponent.vx = 0;
    opponent.action = "stunned";
    opponent.actionUntil = opponent.stunnedUntil;

    io.to(room.code).emit("stunned", {
      player: opponent.name,
      attacker: player.name
    });
    return;
  }

  // Normal steals only work against the opponent holding the ball.
  if (
    ball.owner !== opponent.id ||
    opponent.shootStartedAt !== null
  ) return;

  if (horizontalDistance > STEAL_RANGE || verticalDistance > 42) return;

  ball.owner = player.id;
  ball.vx = 0;
  ball.vy = 0;
  player.action = "steal";
  player.actionUntil = now + 250;

  io.to(room.code).emit("stolen", { player: player.name });
}

function activateAbility(room, player, now = Date.now()) {
  if (
    now < room.jumpBallStartsAt ||
    now < player.abilityCooldownUntil ||
    player.stunnedUntil > now
  ) return false;

  const character = characterFor(player);
  player.abilityUntil = now + 4000;
  player.abilityCooldownUntil = now + ABILITY_COOLDOWN_MS;

  io.to(room.code).emit("abilityUsed", {
    player: player.name,
    character: character.name,
    ability: character.ability,
    side: player.side
  });

  return true;
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
}

function scoreBasket(room, scorer, points) {
  if (room.ball.pendingScore) return;

  scorer.score += points;

  const receiver = room.players.find(p => p.id !== scorer.id);
  const hoopX = scorer.side === 1
    ? COURT.rightHoop
    : COURT.leftHoop;

  room.ball.dunking = false;
  room.ball.owner = null;
  room.ball.shotBySide = null;

  room.ball.x = hoopX;
  room.ball.y = COURT.hoopY - 10;
  room.ball.vx = 0;
  room.ball.vy = 125;
  room.ball.previousX = hoopX;
  room.ball.previousY = room.ball.y;

  room.ball.pendingScore = {
    receiverId: receiver?.id || null,
    resetAt: Date.now() + 1000
  };

  room.ball.pickupLockoutUntil = Date.now() + 1100;

  io.to(room.code).emit("basket", {
    scorer: scorer.name,
    points,
    score: room.players.map(p => p.score)
  });
}

function checkBasket(room) {
  const ball = room.ball;

  if (
    ball.owner ||
    ball.dunking ||
    ball.pendingScore ||
    !ball.shotBySide ||
    ball.vy <= 0
  ) return;

  if (
    !(ball.previousY <= COURT.hoopY &&
      ball.y >= COURT.hoopY)
  ) return;

  const differenceY = ball.y - ball.previousY;
  if (differenceY === 0) return;

  const fraction = clamp(
    (COURT.hoopY - ball.previousY) / differenceY,
    0,
    1
  );

  const crossingX =
    ball.previousX + (ball.x - ball.previousX) * fraction;

  let scorer = null;

  if (
    Math.abs(crossingX - COURT.rightHoop) < 24 &&
    ball.vx > 0 &&
    ball.shotBySide === 1
  ) {
    scorer = room.players.find(p => p.side === 1);
  }

  if (
    Math.abs(crossingX - COURT.leftHoop) < 24 &&
    ball.vx < 0 &&
    ball.shotBySide === 2
  ) {
    scorer = room.players.find(p => p.side === 2);
  }

  if (scorer) {
    scoreBasket(room, scorer, ball.shotPoints || 2);
  }
}

function handleDunk(room, dt) {
  room.ball.dunkTimer -= dt;

  if (room.ball.dunkTimer > 0) return;

  const scorer = room.players.find(
    p => p.side === room.ball.dunkScorerSide
  );

  room.ball.dunking = false;

  if (scorer) {
    scorer.dunking = false;
    scoreBasket(room, scorer, 2);
  }
}

function finishGame(room) {
  if (room.gameOver) return;

  room.gameOver = true;
  room.started = false;

  const [p1, p2] = room.players;
  const winner = p1.score === p2.score
    ? null
    : p1.score > p2.score
      ? p1.name
      : p2.name;

  room.players.forEach(p => {
    p.ready = false;
    p.input = {};
    p.shootStartedAt = null;
  });

  io.to(room.code).emit("gameOver", {
    winner,
    scores: room.players.map(p => ({
      name: p.name,
      score: p.score
    }))
  });

  emitState(room);
}

function updateGameClock(room, now) {
  if (now < room.periodEndsAt) return;

  const [p1, p2] = room.players;

  if (p1.score !== p2.score) {
    finishGame(room);
    return;
  }

  room.overtime += 1;
  room.periodEndsAt = now + OVERTIME_MS;

  io.to(room.code).emit("periodUpdate", {
    overtime: room.overtime,
    duration: OVERTIME_MS
  });
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
      gameOver: false,
      overtime: 0,
      jumpBallStartsAt: null,
      periodEndsAt: 0,
      lastTick: Date.now(),
      snapshotCounter: 0
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;

    socket.emit("roomJoined", publicRoom(room, 1));
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

    const player = createPlayer(socket, name, 2);
    player.characterId = firstAvailableCharacter(room);
    room.players.push(player);

    socket.join(code);
    socket.data.room = code;

    io.to(code).emit("roomUpdate", publicRoom(room));
    socket.emit("roomJoined", publicRoom(room, 2));
  });

  socket.on("selectCharacter", ({ characterId } = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.started) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.ready || !CHARACTERS[characterId]) return;

    const takenByOpponent = room.players.some(
      other => other.id !== player.id && other.characterId === characterId
    );

    if (takenByOpponent) {
      socket.emit("characterSelectError", "That legend is already picked. Choose another.");
      return;
    }

    player.characterId = characterId;
    player.ready = false;
    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("ready", () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.started) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !CHARACTERS[player.characterId]) return;

    player.ready = true;

    if (
      room.players.length === 2 &&
      room.players.every(p => p.ready)
    ) {
      startGame(room);
    }

    io.to(room.code).emit("roomUpdate", publicRoom(room));
  });

  socket.on("dash", data => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started || !room.jumpBallTossStarted) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const direction = Number(data?.direction);
    const now = Date.now();

    if (direction !== -1 && direction !== 1) return;

    if (
      player.stunnedUntil > now ||
      player.dunking ||
      now - player.lastDashAt < DASH_COOLDOWN_MS
    ) return;

    player.lastDashAt = now;
    player.dashDirection = direction;
    player.dashUntil = now + DASH_DURATION_MS;
    player.vx = direction * DASH_SPEED;
  });

  socket.on("input", input => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.started) return;

    const p = room.players.find(player => player.id === socket.id);
    if (!p) return;

    const now = Date.now();
    const countdown = !room.jumpBallTossStarted && now < room.jumpBallStartsAt;

    const next = {
      left: !!input.left,
      right: !!input.right,
      up: !!input.up,
      shoot: countdown ? false : !!input.shoot,
      steal: countdown ? false : !!input.steal,
      pumpFake: countdown ? false : !!input.pumpFake,
      ability: countdown ? false : !!input.ability
    };

    if (next.steal && !p.input.steal) {
      attemptSteal(room, p, now);
    }

    if (next.ability && !p.input.ability) {
      activateAbility(room, p, now);
    }

    if (countdown) {
      p.input = next;
      return;
    }

    if (
      next.pumpFake &&
      !p.input.pumpFake &&
      room.ball.owner === p.id &&
      p.shootStartedAt === null &&
      now - p.lastPumpFakeAt >= 500
    ) {
      p.lastPumpFakeAt = now;
      p.action = "pumpFake";
      p.actionUntil = now + 500;
    }

    if (
      next.shoot &&
      !p.input.shoot &&
      room.ball.owner === p.id
    ) {
      p.shootStartedAt = Date.now();
    }

    if (!next.shoot && p.input.shoot) {
      if (
        p.shootStartedAt !== null &&
        room.ball.owner === p.id
      ) {
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
      room.gameOver = false;
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

    if (now < room.jumpBallStartsAt) {
      room.snapshotCounter += 1;

      if (room.snapshotCounter >= SNAPSHOT_EVERY) {
        room.snapshotCounter = 0;
        emitState(room, now);
      }

      continue;
    }

    if (!room.jumpBallTossStarted) {
      room.jumpBallTossStarted = true;
      room.ball.vx = 0;
      room.ball.vy = -JUMP_BALL_TOSS_SPEED;
      room.lastTick = now;
    }

    updateGameClock(room, now);
    if (!room.started) continue;

    const dt = Math.min(
      (now - room.lastTick) / 1000,
      0.035
    );

    room.lastTick = now;

    for (const player of room.players) {
      movePlayer(player, dt);
    }

    if (room.ball.pendingScore) {
      updateFreeBall(room.ball, dt);

      if (now >= room.ball.pendingScore.resetAt) {
        const receiver = room.players.find(
          p => p.id === room.ball.pendingScore.receiverId
        );

        if (receiver) {
          givePossession(room, receiver);
        }
      }
    } else if (room.ball.dunking) {
      handleDunk(room, dt);
    } else {
      if (room.ball.owner) {
        const holder = room.players.find(p => p.id === room.ball.owner);

        if (holder) {
          followHolder(room.ball, holder);
        } else {
          room.ball.owner = null;
        }
      }

      if (!room.ball.owner) {
        updateFreeBall(room.ball, dt);
        handleBlocks(room);
        checkBasket(room);

        if (!room.ball.pendingScore && !room.ball.owner) {
          tryPickupBall(room);
        }
      }
    }

    for (const p of room.players) {
      if (
        p.actionUntil < now &&
        p.stunnedUntil <= now &&
        !p.dunking
      ) {
        p.action = p.y < COURT.floor ? "jump" : "idle";
      }

      p.previousInput = { ...p.input };
    }

    room.snapshotCounter += 1;

    if (room.snapshotCounter >= SNAPSHOT_EVERY) {
      room.snapshotCounter = 0;
      emitState(room, now);
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Hoop Duel running on port ${PORT}`);
});
