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

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function snapshot(room) {
  return { code: room.code, host: room.host, players: [...room.players.values()].map(({ id, name, color }) => ({ id, name, color })) };
}
function broadcast(room) {
  const data = `data: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const player of room.players.values()) if (player.stream && !player.stream.destroyed) player.stream.write(data);
}
function remove(room, id) {
  const player = room.players.get(id);
  if (!player) return;
  clearTimeout(player.timer);
  if (player.stream) player.stream.end();
  room.players.delete(id);
  if (!room.players.size) { rooms.delete(room.code); return; }
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
    req.on('data', chunk => { data += chunk; if (data.length > 2048) { reject(new Error('Request too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid request.')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', stage: 'lobby' });
  if (req.method === 'POST' && (url.pathname === '/api/create' || url.pathname === '/api/join')) {
    try {
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      if (!name || name.length > 18) return send(res, 400, { error: 'Enter a name between 1 and 18 characters.' });
      let room;
      if (url.pathname === '/api/create') {
        const code = codeForRoom();
        if (!code) return send(res, 503, { error: 'Could not create a room. Please try again.' });
        room = { code, host: null, players: new Map() }; rooms.set(code, room);
      } else {
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        room = rooms.get(code);
        if (!room) return send(res, 404, { error: 'Room not found. Check the code and try again.' });
        if (room.players.size >= 5) return send(res, 409, { error: 'This room is full (5 players maximum).' });
      }
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(24).toString('hex');
      const used = new Set([...room.players.values()].map(p => p.color));
      const player = { id, token, name, color: colors.find(c => !used.has(c)), stream: null, timer: null };
      room.players.set(id, player);
      if (!room.host) room.host = id;
      player.timer = setTimeout(() => remove(room, id), 15000);
      broadcast(room);
      return send(res, 200, { code: room.code, id, token });
    } catch { if (!res.headersSent) return send(res, 400, { error: 'Invalid request.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
    const player = room?.players.get(url.searchParams.get('id'));
    if (!player || player.token !== url.searchParams.get('token')) return send(res, 404, { error: 'Room session expired.' });
    clearTimeout(player.timer);
    if (player.stream) player.stream.end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
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
  if (req.method === 'POST' && url.pathname === '/api/leave') {
    try {
      const body = await readBody(req); const room = rooms.get(body.code); const player = room?.players.get(body.id);
      if (player && player.token === body.token) remove(room, player.id);
      return send(res, 200, { ok: true });
    } catch { return send(res, 400, { error: 'Invalid request.' }); }
  }
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
  const asset = files[url.pathname];
  if (req.method === 'GET' && asset) {
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(path.join(root, asset[0])).pipe(res);
  }
  send(res, 404, { error: 'Not found.' });
});
server.listen(port, '0.0.0.0', () => console.log(`Ghost Heist lobby listening on port ${port}`));
