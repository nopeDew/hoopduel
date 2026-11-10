# Hoop Duel — online 1v1 basketball prototype

A small browser-based, original 1v1 basketball game with private rooms and 6-character join codes.
It is inspired by the *idea* of arcade basketball games, but uses original code and simple drawn graphics.

## Run locally
1. Install Node.js 18 or newer.
2. In this folder, run `npm install`.
3. Run `npm start`.
4. Open http://localhost:3000 in two browser windows (or on two devices on the same network).
5. One player clicks **Create room** and shares the code. The other enters it and clicks **Join**.
6. Both players click **I'm ready**.

## Put it online so friends can join from anywhere
Deploy this folder to a Node hosting service that supports WebSockets (for example Render or Railway). Set the start command to `npm start`. The host will provide a public URL; share that URL and the room code with your friend.

## Controls
- Player 1: A / D to move, W to jump
- Player 2: Left / Right arrows to move, Up to jump
- Both: Space to shoot, Shift to steal

## Notes
This is a playable starting prototype, not a full recreation of Basketball Stars. It has simple physics, a basic ball/hoop model, and private 2-player rooms. It does not yet include character selection, polished animations, sound, shot timing, or anti-cheat protections.
