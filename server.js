'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const colors = ['#48e5ff', '#ff55ae', '#c693ff', '#ffd05a', '#78f6a2'];
const root = path.join(__dirname, 'public');
const port = process.env.PORT || 3000;

// Vault Map Layout (20 cols x 15 rows, 32px tiles = 640x480)
// 0: Floor, 1: Wall, 2: Exit Extraction Zone
const MAP = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,2,2,2,1,0,0,0,0,1,0,0,1,0,0,0,0,0,0,1],
  [1,2,2,2,1,0,1,1,0,1,0,0,1,0,0,0,0,0,0,1],
  [1,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,1,1,0,1,1,0,1,0,0,1,0,0,0,0,0,0,1],
  [1,0,1,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
  [1,0,1,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,1,1,0,1,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,1,1,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
  [1,0,1,1,1,0,1,1,1,0,0,0,1,0,0,0,0,0,0,1],
  [1,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,1,0,1,0,1,1,1,0,0,0,1,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
];

function createTreasures() {
  return [
    { id: 't1', name: 'Gold Ingot', type: 'gold', x: 6 * 32 + 16, y: 7 * 32 + 16, val: 100, collected: false, collectedBy: null },
    { id: 't2', name: 'Emerald Gem', type: 'emerald', x: 10 * 32 + 16, y: 7 * 32 + 16, val: 150, collected: false, collectedBy: null },
    { id: 't3', name: 'Ruby Gem', type: 'ruby', x: 18 * 32 + 16, y: 7 * 32 + 16, val: 150, collected: false, collectedBy: null },
    { id: 't4', name: 'Sapphire Gem', type: 'sapphire', x: 14 * 32 + 16, y: 2 * 32 + 16, val: 150, collected: false, collectedBy: null },
    { id: 't5', name: 'Gold Chest', type: 'chest', x: 17 * 32 + 16, y: 2 * 32 + 16, val: 200, collected: false, collectedBy: null },
    { id: 't6', name: 'Diamond Gem', type: 'diamond', x: 15 * 32 + 16, y: 4 * 32 + 16, val: 200, collected: false, collectedBy: null },
    { id: 't7', name: 'Coin Sack', type: 'sack', x: 3 * 32 + 16, y: 11 * 32 + 16, val: 100, collected: false, collectedBy: null },
    { id: 't8', name: 'Ancient Goblet', type: 'goblet', x: 8 * 32 + 16, y: 13 * 32 + 16, val: 100, collected: false, collectedBy: null },
    { id: 't9', name: 'Golden Relic', type: 'relic', x: 6 * 32 + 16, y: 3 * 32 + 16, val: 150, collected: false, collectedBy: null },
    { id: 'tc', name: 'Royal Ghost Crown', type: 'crown', x: 17 * 32 + 16, y: 12 * 32 + 16, val: 350, isSpecial: true, collected: false, collectedBy: null }
  ];
}

function createLasers() {
  return [
    { id: 'l1', x1: 7 * 32, y1: 6 * 32 + 16, x2: 11 * 32, y2: 6 * 32 + 16, cycle: 3600, onTime: 2200, offset: 0, active: false, warning: false },
    { id: 'l2', x1: 16 * 32 + 16, y1: 6 * 32, x2: 16 * 32 + 16, y2: 9 * 32, cycle: 3600, onTime: 2200, offset: 1800, active: false, warning: false }
  ];
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function snapshot(room) {
  return {
    type: 'lobby_update',
    code: room.code,
    host: room.host,
    status: room.status,
    round: room.round,
    players: [...room.players.values()].map(({ id, name, color, score, escaped }) => ({ id, name, color, score, escaped }))
  };
}

function sendToPlayer(player, data) {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  if (player.ws && !player.ws.destroyed) {
    wsSend(player.ws, json);
  }
  if (player.stream && !player.stream.destroyed) {
    player.stream.write(`data: ${json}\n\n`);
  }
}

function broadcast(room, customData) {
  const payload = customData || snapshot(room);
  for (const player of room.players.values()) {
    sendToPlayer(player, payload);
  }
}

function remove(room, id) {
  const player = room.players.get(id);
  if (!player) return;
  clearTimeout(player.timer);
  if (player.stream) player.stream.end();
  if (player.ws) player.ws.destroy();
  room.players.delete(id);
  if (!room.players.size) {
    if (room.game?.interval) clearInterval(room.game.interval);
    rooms.delete(room.code);
    return;
  }
  if (room.host === id) room.host = room.players.keys().next().value;
  broadcast(room);
}

function codeForRoom() {
  for (let n = 0; n < 1000; n++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 4096) { reject(new Error('Request too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid request.')); } });
    req.on('error', reject);
  });
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function getGhostPos(trail, elapsed) {
  if (!trail || !trail.length) return null;
  if (elapsed <= trail[0].t) return trail[0];
  if (elapsed >= trail[trail.length - 1].t) return trail[trail.length - 1];
  let low = 0, high = trail.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (trail[mid].t === elapsed) return trail[mid];
    if (trail[mid].t < elapsed) low = mid + 1;
    else high = mid - 1;
  }
  const p0 = trail[Math.max(0, high)], p1 = trail[Math.min(trail.length - 1, low)];
  const dt = p1.t - p0.t;
  if (dt <= 0) return p0;
  const f = (elapsed - p0.t) / dt;
  return {
    x: p0.x + (p1.x - p0.x) * f,
    y: p0.y + (p1.y - p0.y) * f,
    dir: p1.dir || p0.dir
  };
}

function startGame(room) {
  if (room.game?.interval) clearInterval(room.game.interval);
  room.status = 'playing';
  room.round = (room.round || 0) + 1;

  // Initialize player game stats & spawn points
  let idx = 0;
  for (const p of room.players.values()) {
    p.x = 48 + (idx % 3) * 24;
    p.y = 416 + Math.floor(idx / 3) * 20;
    p.dir = 'up';
    p.score = 0;
    p.escaped = false;
    p.zapped = 0;
    p.trail = [];
    idx++;
  }

  room.game = {
    startTime: Date.now(),
    durationMs: 30000,
    treasures: createTreasures(),
    lasers: createLasers(),
    switches: {
      s1: { id: 's1', name: 'Switch A (Held)', x: 10 * 32 + 16, y: 11 * 32 + 16, pressed: false },
      s1_exit: { id: 's1_exit', name: 'Emergency Exit Release', x: 14 * 32 + 16, y: 11 * 32 + 16, pressed: false },
      s2: { id: 's2', name: 'Switch B (Timer)', x: 8 * 32 + 16, y: 3 * 32 + 16, pressed: false, until: 0 }
    },
    doors: {
      d1: { col: 12, row: 11, open: false },
      d2: { col: 12, row: 3, open: false }
    },
    ghosts: room.savedGhosts || [],
    interval: setInterval(() => tickGame(room), 50)
  };

  broadcast(room, {
    type: 'game_start',
    code: room.code,
    round: room.round,
    duration: 30,
    treasures: room.game.treasures,
    ghosts: room.game.ghosts.map(g => ({ id: g.id, name: g.name, color: g.color }))
  });
}

function tickGame(room) {
  if (room.status !== 'playing' || !room.game) return;
  const now = Date.now();
  const elapsed = now - room.game.startTime;
  const timeLeft = Math.max(0, Math.ceil((room.game.durationMs - elapsed) / 1000));
  const events = [];

  // 1. Advance Lasers
  for (const laser of room.game.lasers) {
    const cyclePos = (elapsed + laser.offset) % laser.cycle;
    laser.active = cyclePos < laser.onTime;
    laser.warning = cyclePos >= (laser.onTime - 600) && cyclePos < laser.onTime;
  }

  // 2. Evaluate Ghosts at current timestamp
  const activeGhosts = [];
  for (const g of room.game.ghosts) {
    const pos = getGhostPos(g.trail, elapsed);
    if (pos) {
      activeGhosts.push({ id: g.id, name: g.name, color: g.color, x: Math.round(pos.x), y: Math.round(pos.y), dir: pos.dir });
    }
  }

  // 3. Pressure Switches (checked against all living players and ghosts)
  const activeActors = [...room.players.values()]
    .filter(p => !p.escaped)
    .map(p => ({ x: p.x, y: p.y }))
    .concat(activeGhosts.map(g => ({ x: g.x, y: g.y })));

  // S1 (Outside held switch) & S1_EXIT (Inside release switch)
  const s1Pressed = activeActors.some(a => Math.hypot(a.x - room.game.switches.s1.x, a.y - room.game.switches.s1.y) < 22);
  const s1ExitPressed = activeActors.some(a => Math.hypot(a.x - room.game.switches.s1_exit.x, a.y - room.game.switches.s1_exit.y) < 22);
  room.game.switches.s1.pressed = s1Pressed;
  room.game.switches.s1_exit.pressed = s1ExitPressed;

  // Door 1 opens if S1 or S1_EXIT is pressed
  room.game.doors.d1.open = s1Pressed || s1ExitPressed;

  // S2 (North Vault switch)
  const s2Pressed = activeActors.some(a => Math.hypot(a.x - room.game.switches.s2.x, a.y - room.game.switches.s2.y) < 22);
  if (s2Pressed) room.game.switches.s2.until = now + 8000;
  room.game.switches.s2.pressed = s2Pressed || (now < room.game.switches.s2.until);
  room.game.doors.d2.open = room.game.switches.s2.pressed;

  // 4. Laser Collisions with non-escaped players
  for (const p of room.players.values()) {
    if (p.escaped) continue;
    if (now - (p.zapped || 0) < 1500) continue; // temporary grace period after zap
    for (const laser of room.game.lasers) {
      if (laser.active && distToSegment(p.x, p.y, laser.x1, laser.y1, laser.x2, laser.y2) < 14) {
        p.zapped = now;
        p.score = Math.max(0, p.score - 50);
        // Knockback respawn to vault entrance
        p.x = 48 + Math.floor(Math.random() * 40);
        p.y = 416;
        events.push({ type: 'zapped', playerId: p.id, name: p.name });
        break;
      }
    }
  }

  // 5. Treasure Pickups
  for (const t of room.game.treasures) {
    if (t.collected) continue;
    for (const p of room.players.values()) {
      if (p.escaped) continue;
      if (Math.hypot(p.x - t.x, p.y - t.y) < 22) {
        t.collected = true;
        t.collectedBy = p.id;
        p.score += t.val;
        events.push({ type: 'pickup', playerId: p.id, name: p.name, treasureId: t.id, val: t.val, isSpecial: !!t.isSpecial });
        break;
      }
    }
  }

  // 6. Extraction / Exit Zone (Cols 1-3, Rows 1-2: x: 32..128, y: 32..96)
  let allEscaped = room.players.size > 0;
  for (const p of room.players.values()) {
    if (!p.escaped) {
      if (p.x >= 32 && p.x <= 128 && p.y >= 32 && p.y <= 96) {
        p.escaped = true;
        p.score += 200; // Escape bonus!
        events.push({ type: 'escaped', playerId: p.id, name: p.name, score: p.score });
      } else {
        allEscaped = false;
      }
    }
  }

  // 7. Record living players' trails for Ghost system
  for (const p of room.players.values()) {
    if (p.trail) {
      p.trail.push({ t: elapsed, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir || 'up' });
    }
  }

  // 8. Check Round Over
  if (elapsed >= room.game.durationMs || (allEscaped && room.players.size > 0)) {
    endGame(room, allEscaped);
    return;
  }

  // 9. Broadcast Game Tick
  const payload = {
    type: 'game_tick',
    timeLeft,
    elapsed,
    doors: room.game.doors,
    switches: {
      s1: room.game.switches.s1.pressed,
      s1_exit: room.game.switches.s1_exit.pressed,
      s2: room.game.switches.s2.pressed
    },
    lasers: room.game.lasers.map(l => ({ id: l.id, active: l.active, warning: l.warning })),
    treasures: room.game.treasures.map(t => ({ id: t.id, collected: t.collected, collectedBy: t.collectedBy })),
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      dir: p.dir,
      score: p.score,
      escaped: p.escaped,
      isZapped: now - (p.zapped || 0) < 1500
    })),
    ghosts: activeGhosts,
    events
  };

  broadcast(room, payload);
}

function endGame(room, allEscaped) {
  if (room.game?.interval) clearInterval(room.game.interval);
  room.status = 'ended';

  // Save trails from this round as ghosts for future rounds!
  room.savedGhosts = [...room.players.values()].map(p => ({
    id: `ghost_${p.id}`,
    name: p.name,
    color: p.color,
    trail: p.trail || []
  }));

  const scoreboard = [...room.players.values()]
    .map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      escaped: p.escaped,
      treasuresCount: room.game.treasures.filter(t => t.collectedBy === p.id).length
    }))
    .sort((a, b) => b.score - a.score);

  const teamScore = scoreboard.reduce((sum, p) => sum + p.score, 0);

  broadcast(room, {
    type: 'round_ended',
    round: room.round,
    teamScore,
    allEscaped,
    hasGhosts: room.savedGhosts.length > 0,
    scoreboard
  });
}

// WebSocket Helper Functions (zero-dependency RFC 6455)
function wsSend(socket, data) {
  if (socket.destroyed) return;
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { status: 'ok', stage: 'b-c', rooms: rooms.size });
  }

  // Room creation and joining
  if (req.method === 'POST' && (url.pathname === '/api/create' || url.pathname === '/api/join')) {
    try {
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 18) return send(res, 400, { error: 'Enter a name between 1 and 18 characters.' });
      let room;
      if (url.pathname === '/api/create') {
        const code = codeForRoom();
        if (!code) return send(res, 503, { error: 'Could not create a room. Please try again.' });
        room = { code, host: null, status: 'lobby', round: 0, players: new Map(), savedGhosts: [] };
        rooms.set(code, room);
      } else {
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        room = rooms.get(code);
        if (!room) return send(res, 404, { error: 'Room not found. Check the code and try again.' });
        if (room.players.size >= 5) return send(res, 409, { error: 'This room is full (5 players maximum).' });
      }
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(24).toString('hex');
      const used = new Set([...room.players.values()].map(p => p.color));
      const player = {
        id,
        token,
        name,
        color: colors.find(c => !used.has(c)) || '#ffffff',
        stream: null,
        ws: null,
        timer: null,
        x: 64,
        y: 416,
        score: 0,
        escaped: false,
        zapped: 0
      };
      room.players.set(id, player);
      if (!room.host) room.host = id;
      player.timer = setTimeout(() => remove(room, id), 15000);
      broadcast(room);
      return send(res, 200, { code: room.code, id, token });
    } catch {
      if (!res.headersSent) return send(res, 400, { error: 'Invalid request.' });
    }
  }

  // SSE Stream
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
    const player = room?.players.get(url.searchParams.get('id'));
    if (!player || player.token !== url.searchParams.get('token')) return send(res, 404, { error: 'Room session expired.' });
    clearTimeout(player.timer);
    if (player.stream) player.stream.end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    player.stream = res;
    res.write(`data: ${JSON.stringify(snapshot(room))}\n\n`);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 10000);
    req.on('close', () => {
      clearInterval(heartbeat);
      if (player.stream !== res) return;
      player.stream = null;
      player.timer = setTimeout(() => remove(room, player.id), 12000);
    });
    return;
  }

  // Game action POST endpoints (for HTTP / mobile compatibility)
  if (req.method === 'POST' && url.pathname === '/api/start') {
    try {
      const body = await readBody(req);
      const room = rooms.get(body.code);
      const player = room?.players.get(body.id);
      if (!player || player.token !== body.token || room.host !== player.id) {
        return send(res, 403, { error: 'Only the host can start the heist.' });
      }
      startGame(room);
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'Invalid request.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/move') {
    try {
      const body = await readBody(req);
      const room = rooms.get(body.code);
      const player = room?.players.get(body.id);
      if (player && player.token === body.token && room.status === 'playing' && !player.escaped) {
        if (typeof body.x === 'number' && typeof body.y === 'number') {
          player.x = Math.max(20, Math.min(620, body.x));
          player.y = Math.max(20, Math.min(460, body.y));
          if (body.dir) player.dir = body.dir;
        }
      }
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'Invalid request.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/lobby') {
    try {
      const body = await readBody(req);
      const room = rooms.get(body.code);
      const player = room?.players.get(body.id);
      if (!player || player.token !== body.token || room.host !== player.id) {
        return send(res, 403, { error: 'Only the host can return to lobby.' });
      }
      if (room.game?.interval) clearInterval(room.game.interval);
      room.status = 'lobby';
      broadcast(room);
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'Invalid request.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/leave') {
    try {
      const body = await readBody(req);
      const room = rooms.get(body.code);
      const player = room?.players.get(body.id);
      if (player && player.token === body.token) remove(room, player.id);
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: 'Invalid request.' });
    }
  }

  // Static Assets
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8']
  };
  const asset = files[url.pathname];
  if (req.method === 'GET' && asset) {
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(root, asset[0])).pipe(res);
  }

  send(res, 404, { error: 'Not found.' });
});

// Native WebSocket server upgrade handler
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  const room = rooms.get(code);
  const player = room?.players.get(id);

  if (!player || player.token !== token) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  clearTimeout(player.timer);
  if (player.ws) player.ws.destroy();
  player.ws = socket;

  // Send current state immediately upon WS connect
  if (room.status === 'playing' && room.game) {
    wsSend(socket, {
      type: 'game_start',
      code: room.code,
      round: room.round,
      duration: 30,
      treasures: room.game.treasures,
      ghosts: room.game.ghosts.map(g => ({ id: g.id, name: g.name, color: g.color }))
    });
  } else {
    wsSend(socket, snapshot(room));
  }

  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const byte0 = buffer[0];
      const byte1 = buffer[1];
      const opcode = byte0 & 0x0f;
      const isMasked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (isMasked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }

      buffer = buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x08) {
        socket.end();
        return;
      } else if (opcode === 0x09) {
        socket.write(Buffer.from([0x8a, 0x00])); // pong
      } else if (opcode === 0x01) {
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.type === 'move' && room.status === 'playing' && !player.escaped) {
            if (typeof msg.x === 'number' && typeof msg.y === 'number') {
              player.x = Math.max(20, Math.min(620, msg.x));
              player.y = Math.max(20, Math.min(460, msg.y));
              if (msg.dir) player.dir = msg.dir;
            }
          } else if (msg.type === 'start' && room.host === player.id) {
            startGame(room);
          } else if (msg.type === 'lobby' && room.host === player.id) {
            if (room.game?.interval) clearInterval(room.game.interval);
            room.status = 'lobby';
            broadcast(room);
          }
        } catch {}
      }
    }
  });

  socket.on('close', () => {
    if (player.ws === socket) {
      player.ws = null;
      player.timer = setTimeout(() => remove(room, player.id), 12000);
    }
  });

  socket.on('error', () => {
    socket.destroy();
  });
});

server.listen(port, '0.0.0.0', () => console.log(`Ghost Heist listening on port ${port}`));
