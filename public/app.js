'use strict';

const $ = id => document.getElementById(id);

// Session & Networking state
let session = null;
let sseSource = null;
let socket = null;
let currentRoom = null;
let soundEnabled = true;
let audioCtx = null;

// Map Configuration (20 cols x 15 rows, 32px per tile = 640 x 480)
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

// Local Game Simulation state
const game = {
  active: false,
  round: 1,
  timeLeft: 30,
  teamScore: 0,
  doors: { d1: { open: false }, d2: { open: false } },
  switches: { s1: false, s1_exit: false, s2: false },
  lasers: [
    { id: 'l1', x1: 7 * 32, y1: 6 * 32 + 16, x2: 11 * 32, y2: 6 * 32 + 16, active: false, warning: false },
    { id: 'l2', x1: 16 * 32 + 16, y1: 6 * 32, x2: 16 * 32 + 16, y2: 9 * 32, active: false, warning: false }
  ],
  treasures: [],
  players: new Map(),
  ghosts: [],
  particles: [],
  floatTexts: [],
  toastTimer: null,
  lastTickTime: performance.now(),
  lastMoveSent: 0
};

// Local Player Control state
const myInput = {
  up: false,
  down: false,
  left: false,
  right: false,
  targetX: null,
  targetY: null
};

// UI Elements
const entryScreen = $('entry');
const lobbyScreen = $('lobby');
const gameScreen = $('game');
const resultsScreen = $('results');
const entryError = $('entry-error');
const lobbyError = $('lobby-error');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

function showError(node, text) {
  if (node) node.textContent = text;
}

function showToast(text, duration = 2200) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(game.toastTimer);
  game.toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

// ============================================================
// AUDIO SYNTHESIZER (Web Audio API)
// ============================================================
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playSound(type) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  try {
    if (type === 'pickup') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.12); // G5
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'crown') {
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.08);
        gain.gain.setValueAtTime(0.25, now + i * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.08 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.25);
      });
    } else if (type === 'switch') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.08);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'door') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.linearRampToValueAtTime(80, now + 0.2);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'zap') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.linearRampToValueAtTime(70, now + 0.2);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.22);
    } else if (type === 'escape') {
      [440, 554.37, 659.25].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.1);
        gain.gain.setValueAtTime(0.25, now + i * 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.1);
        osc.stop(now + i * 0.1 + 0.3);
      });
    } else if (type === 'tick') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.04);
    }
  } catch {}
}

$('sound-btn').onclick = () => {
  soundEnabled = !soundEnabled;
  $('sound-btn').textContent = soundEnabled ? '🔊' : '🔇';
  $('sound-btn').title = soundEnabled ? 'Mute Sound' : 'Unmute Sound';
  if (soundEnabled) getAudioContext();
};

// ============================================================
// WEBSOCKET & SSE MESSAGING
// ============================================================
function connectTransport() {
  if (!session) return;

  // 1. Establish SSE as robust fallback stream
  const sseParams = new URLSearchParams(session);
  if (sseSource) sseSource.close();
  sseSource = new EventSource('/api/events?' + sseParams);
  sseSource.onmessage = event => {
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch {}
  };
  sseSource.onerror = () => {
    showError(lobbyError, 'Connection lost. Reconnecting…');
  };

  // 2. Establish native WebSocket for low-latency movement & real-time ticks
  try {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/ws?code=${session.code}&id=${session.id}&token=${session.token}`;
    if (socket) socket.close();
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      showError(lobbyError, '');
    };

    socket.onmessage = e => {
      try {
        handleServerMessage(JSON.parse(e.data));
      } catch {}
    };

    socket.onclose = () => {
      socket = null;
    };
  } catch {}
}

function sendAction(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else if (session) {
    // Fallback to HTTP POST
    const endpoint = msg.type === 'start' ? '/api/start' : msg.type === 'lobby' ? '/api/lobby' : '/api/move';
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ code: session.code, id: session.id, token: session.token }, msg))
    }).catch(() => {});
  }
}

function handleServerMessage(data) {
  if (!data) return;

  // LOBBY UPDATE
  if (data.type === 'lobby_update' || (data.code && data.players && !data.type)) {
    currentRoom = data;
    renderLobby(data);
    if (data.status === 'lobby' || !data.status) {
      if (!gameScreen.hidden || !resultsScreen.hidden) {
        showScreen('lobby');
      }
    }
  }

  // GAME START
  else if (data.type === 'game_start') {
    startLocalGame(data);
  }

  // GAME TICK (20Hz sync)
  else if (data.type === 'game_tick') {
    applyGameTick(data);
  }

  // ROUND ENDED
  else if (data.type === 'round_ended') {
    finishRound(data);
  }
}

// ============================================================
// SCREEN NAVIGATION
// ============================================================
function showScreen(name) {
  entryScreen.hidden = name !== 'entry';
  lobbyScreen.hidden = name !== 'lobby';
  gameScreen.hidden = name !== 'game';
  resultsScreen.hidden = name !== 'results';
}

function renderLobby(room) {
  showError(lobbyError, '');
  $('room-code').textContent = room.code;
  $('hud-code').textContent = room.code;
  $('count').textContent = `${room.players.length} / 5`;
  $('players').replaceChildren();

  room.players.forEach(player => {
    const row = document.createElement('div');
    row.className = 'player';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = player.color;
    dot.style.color = player.color;
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.name + (player.id === session.id ? ' (you)' : '');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = player.id === room.host ? 'HOST' : '';
    row.append(dot, name, badge);
    $('players').append(row);
  });

  const isHost = room.host === session.id;
  $('start').hidden = !isHost;
  $('start').disabled = !isHost;
  $('status').textContent = isHost
    ? (room.players.length < 2 ? 'You can test solo or wait for crew members to join.' : 'Your crew is assembled. Launch the heist!')
    : 'Waiting for the host to launch the heist.';
}

// ============================================================
// ENTRY / LOBBY HANDLERS
// ============================================================
async function enter(action) {
  getAudioContext();
  showError(entryError, '');
  $('create').disabled = true;
  $('join').disabled = true;

  try {
    const nameVal = $('name').value.trim();
    const codeVal = $('code').value.trim();
    const res = await fetch(`/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameVal, code: codeVal })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Connection failed.');

    session = data;
    showScreen('lobby');
    connectTransport();
  } catch (err) {
    showError(entryError, err.message || 'Unable to connect.');
  } finally {
    $('create').disabled = false;
    $('join').disabled = false;
  }
}

$('create').onclick = () => enter('create');
$('join').onclick = () => enter('join');
$('code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

$('leave').onclick = () => {
  leaveRoom();
};
$('results-leave').onclick = () => {
  leaveRoom();
};

function leaveRoom() {
  const current = session;
  if (sseSource) sseSource.close();
  if (socket) socket.close();
  sseSource = null;
  socket = null;
  session = null;
  game.active = false;

  if (current) {
    fetch('/api/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current),
      keepalive: true
    }).catch(() => {});
  }

  showScreen('entry');
  showError(entryError, '');
}

$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('room-code').textContent);
    $('copy').textContent = 'Copied!';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1800);
  } catch {
    $('copy').textContent = 'Code above';
  }
};

$('start').onclick = () => {
  getAudioContext();
  sendAction({ type: 'start' });
};

$('play-again').onclick = () => {
  getAudioContext();
  sendAction({ type: 'start' });
};

$('results-lobby').onclick = () => {
  sendAction({ type: 'lobby' });
};

// ============================================================
// GAME LOGIC & RENDERING
// ============================================================
function startLocalGame(data) {
  game.active = true;
  game.round = data.round || 1;
  game.timeLeft = data.duration || 30;
  game.treasures = data.treasures || [];
  game.particles = [];
  game.floatTexts = [];
  game.doors = { d1: { open: false }, d2: { open: false } };
  game.switches = { s1: false, s1_exit: false, s2: false };

  showScreen('game');
  $('hud-timer').textContent = `${game.timeLeft}s`;
  $('hud-timer').classList.remove('urgent');
  $('hud-score').textContent = '$0';
  showToast(game.round === 1 ? 'VAULT INFILTRATION STARTED! 30s ON THE CLOCK!' : `ROUND ${game.round}: GHOST TIMELINES ACTIVE!`);
  playSound('switch');
}

function applyGameTick(tick) {
  if (!game.active) {
    game.active = true;
    showScreen('game');
  }

  // Update timer
  if (game.timeLeft !== tick.timeLeft) {
    if (tick.timeLeft <= 10 && tick.timeLeft > 0) playSound('tick');
  }
  game.timeLeft = tick.timeLeft;
  $('hud-timer').textContent = `${tick.timeLeft}s`;
  if (tick.timeLeft <= 10) {
    $('hud-timer').classList.add('urgent');
  } else {
    $('hud-timer').classList.remove('urgent');
  }

  // Update Doors & Switches (with audio cues on change)
  if (tick.doors) {
    if (tick.doors.d1.open !== game.doors.d1.open || tick.doors.d2.open !== game.doors.d2.open) {
      playSound('door');
      if (tick.doors.d1.open && !game.doors.d1.open) showToast('DOOR A UNLOCKED!');
      if (tick.doors.d2.open && !game.doors.d2.open) showToast('DOOR B UNLOCKED!');
    }
    game.doors = tick.doors;
  }
  if (tick.switches) {
    if ((tick.switches.s1 && !game.switches.s1) || (tick.switches.s1_exit && !game.switches.s1_exit) || (tick.switches.s2 && !game.switches.s2)) {
      playSound('switch');
    }
    game.switches = tick.switches;
  }

  // Update Lasers
  if (tick.lasers) {
    tick.lasers.forEach(l => {
      const match = game.lasers.find(x => x.id === l.id);
      if (match) {
        match.active = l.active;
        match.warning = l.warning;
      }
    });
  }

  // Update Treasures
  if (tick.treasures) {
    tick.treasures.forEach(t => {
      const match = game.treasures.find(x => x.id === t.id);
      if (match) {
        match.collected = t.collected;
        match.collectedBy = t.collectedBy;
      }
    });
  }

  // Update Players (sync server target positions for smooth interpolation)
  let teamTotal = 0;
  if (tick.players) {
    tick.players.forEach(p => {
      teamTotal += (p.score || 0);
      let local = game.players.get(p.id);
      if (!local) {
        local = {
          id: p.id,
          name: p.name,
          color: p.color,
          x: p.x,
          y: p.y,
          renderX: p.x,
          renderY: p.y,
          dir: p.dir || 'up',
          score: p.score || 0,
          escaped: p.escaped,
          isZapped: p.isZapped
        };
        game.players.set(p.id, local);
      } else {
        local.name = p.name;
        local.color = p.color;
        local.score = p.score || 0;
        local.escaped = p.escaped;
        local.isZapped = p.isZapped;
        local.dir = p.dir || local.dir;

        // If not me, set server target for smooth lerp
        if (session && p.id !== session.id) {
          local.targetX = p.x;
          local.targetY = p.y;
        } else if (session && p.id === session.id) {
          // If server reports zap knockback, snap local position
          if (p.isZapped && Math.hypot(local.x - p.x, local.y - p.y) > 40) {
            local.x = p.x;
            local.y = p.y;
            local.renderX = p.x;
            local.renderY = p.y;
          }
        }
      }
    });
  }
  game.teamScore = teamTotal;
  $('hud-score').textContent = `$${teamTotal.toLocaleString()}`;

  // Update Ghosts
  game.ghosts = tick.ghosts || [];

  // Update Crew Tracker Bar
  updateCrewTracker();

  // Process transient game events
  if (tick.events && tick.events.length) {
    tick.events.forEach(ev => {
      if (ev.type === 'pickup') {
        if (ev.isSpecial) {
          playSound('crown');
          showToast(`👑 ${ev.name} LOOTED THE ROYAL GHOST CROWN (+$${ev.val})!`, 3000);
        } else {
          playSound('pickup');
          showToast(`💰 ${ev.name} found ${ev.val} Loot!`);
        }
        const tObj = game.treasures.find(x => x.id === ev.treasureId);
        if (tObj) {
          addFloatingText(`+$${ev.val}`, tObj.x, tObj.y, '#ffd05a');
          addSparkleParticles(tObj.x, tObj.y, ev.isSpecial ? '#ffd05a' : '#5ce6f6', 16);
        }
      } else if (ev.type === 'zapped') {
        playSound('zap');
        showToast(`⚡ ${ev.name} was zapped by a security laser! (-$50)`);
        const pObj = game.players.get(ev.playerId);
        if (pObj) {
          addFloatingText('- $50', pObj.renderX, pObj.renderY, '#ff486a');
          addSparkleParticles(pObj.renderX, pObj.renderY, '#ff486a', 20);
        }
      } else if (ev.type === 'escaped') {
        playSound('escape');
        showToast(`🚀 ${ev.name} SAFELY ESCAPED THE VAULT (+200 pts)!`, 2500);
        const pObj = game.players.get(ev.playerId);
        if (pObj) {
          addFloatingText('ESCAPED! +200', pObj.renderX, pObj.renderY, '#48f0a0');
        }
      }
    });
  }
}

function updateCrewTracker() {
  const tracker = $('crew-tracker');
  if (!tracker) return;
  tracker.replaceChildren();

  game.players.forEach(p => {
    const badge = document.createElement('div');
    badge.className = 'crew-badge' + (p.escaped ? ' escaped' : p.isZapped ? ' zapped' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    dot.style.color = p.color;

    const label = document.createElement('span');
    const isMe = session && p.id === session.id;
    label.textContent = `${p.name}${isMe ? ' (you)' : ''}: $${p.score}${p.escaped ? ' ✓' : ''}`;

    badge.append(dot, label);
    tracker.append(badge);
  });
}

function finishRound(data) {
  game.active = false;
  showScreen('results');

  const isHost = currentRoom && currentRoom.host === session?.id;
  $('play-again').hidden = !isHost;
  $('results-lobby').hidden = !isHost;
  $('results-waiting').hidden = isHost;

  $('res-round').textContent = data.round || 1;
  $('res-loot').textContent = `$${(data.teamScore || 0).toLocaleString()}`;
  const escapedCount = (data.scoreboard || []).filter(p => p.escaped).length;
  $('res-escaped').textContent = `${escapedCount} / ${(data.scoreboard || []).length}`;

  if (escapedCount === (data.scoreboard || []).length && escapedCount > 0) {
    $('results-title').innerHTML = 'Perfect <em>Heist!</em>';
    $('results-lead').textContent = 'Every crew member extracted safely before lockdown!';
  } else if (escapedCount > 0) {
    $('results-title').innerHTML = 'Vault <em>Plundered.</em>';
    $('results-lead').textContent = `${escapedCount} operative(s) made it out with the loot.`;
  } else {
    $('results-title').innerHTML = 'Vault <em>Lockdown.</em>';
    $('results-lead').textContent = 'The security grid locked down before extraction!';
  }

  // Scoreboard
  const container = $('results-players');
  container.replaceChildren();
  (data.scoreboard || []).forEach((p, rank) => {
    const row = document.createElement('div');
    row.className = 'player';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    dot.style.color = p.color;

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = `#${rank + 1} ${p.name} (${p.treasuresCount} treasures, ${p.escaped ? 'Escaped ✓' : 'Caught'})`;

    const score = document.createElement('strong');
    score.style.color = '#ffd05a';
    score.textContent = `$${p.score}`;

    row.append(dot, name, score);
    container.append(row);
  });

  if (data.hasGhosts) {
    $('ghost-tip').textContent = 'Your timeline was saved! In Round 2, your past ghost will run in sync and hold the switch to unlock the Royal Ghost Crown!';
  }
}

// ============================================================
// MOVEMENT & COLLISION ENGINE
// ============================================================
function isWalkable(x, y, radius) {
  // Check 4 bounding corners
  const offsets = [
    [-radius, -radius],
    [radius, -radius],
    [-radius, radius],
    [radius, radius]
  ];
  for (const [ox, oy] of offsets) {
    const col = Math.floor((x + ox) / 32);
    const row = Math.floor((y + oy) / 32);

    if (col < 0 || col >= 20 || row < 0 || row >= 15) return false;
    if (MAP[row][col] === 1) return false; // Wall

    // Door 1 (Ghost Vault Door at col 12, row 11)
    if (col === 12 && row === 11 && !game.doors.d1.open) {
      // Safety guarantee: if player is ALREADY inside the vault room (col >= 13) or in door, allow exiting to col 11!
      if (x < 12 * 32) return false; // trying to enter closed door
    }

    // Door 2 (North Vault Door at col 12, row 3)
    if (col === 12 && row === 3 && !game.doors.d2.open) {
      if (x < 12 * 32) return false;
    }
  }
  return true;
}

function updateLocalPlayer(dt) {
  if (!game.active || !session) return;
  const me = game.players.get(session.id);
  if (!me || me.escaped) return;

  const speed = 145; // pixels per second
  let dx = 0, dy = 0;

  if (myInput.up) dy -= 1;
  if (myInput.down) dy += 1;
  if (myInput.left) dx -= 1;
  if (myInput.right) dx += 1;

  // Touch-to-walk target
  if (myInput.targetX !== null && myInput.targetY !== null) {
    const toX = myInput.targetX - me.x;
    const toY = myInput.targetY - me.y;
    const dist = Math.hypot(toX, toY);
    if (dist > 8) {
      dx = toX / dist;
      dy = toY / dist;
    } else {
      myInput.targetX = null;
      myInput.targetY = null;
    }
  }

  if (dx !== 0 && dy !== 0) {
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
  }

  if (dx !== 0 || dy !== 0) {
    // Set direction facing
    if (Math.abs(dx) > Math.abs(dy)) {
      me.dir = dx > 0 ? 'right' : 'left';
    } else {
      me.dir = dy > 0 ? 'down' : 'up';
    }

    const moveDist = speed * dt;
    const targetX = me.x + dx * moveDist;
    const targetY = me.y + dy * moveDist;

    // Corner sliding: resolve X and Y independently
    if (isWalkable(targetX, me.y, 11)) {
      me.x = targetX;
    }
    if (isWalkable(me.x, targetY, 11)) {
      me.y = targetY;
    }

    // Send position update to server at ~20Hz
    const now = performance.now();
    if (now - game.lastMoveSent > 45) {
      game.lastMoveSent = now;
      sendAction({
        type: 'move',
        x: Math.round(me.x),
        y: Math.round(me.y),
        dir: me.dir
      });
    }
  }
}

// Particle & Floating Text helpers
function addFloatingText(text, x, y, color) {
  game.floatTexts.push({ text, x, y, color, life: 1.0 });
}

function addSparkleParticles(x, y, color, count = 12) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd = 20 + Math.random() * 60;
    game.particles.push({
      x, y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      color,
      size: 2 + Math.random() * 3,
      life: 1.0
    });
  }
}

// ============================================================
// MAIN RENDER LOOP (60 FPS)
// ============================================================
function renderFrame(now) {
  requestAnimationFrame(renderFrame);
  const dt = Math.min(0.1, (now - game.lastTickTime) / 1000);
  game.lastTickTime = now;

  if (!game.active) return;

  // 1. Update local player movement
  updateLocalPlayer(dt);

  // 2. Interpolate remote players smoothly
  game.players.forEach(p => {
    if (p.id !== session?.id && p.targetX !== undefined) {
      p.renderX += (p.targetX - p.renderX) * 0.35;
      p.renderY += (p.targetY - p.renderY) * 0.35;
    } else {
      p.renderX = p.x;
      p.renderY = p.y;
    }
  });

  // 3. Clear canvas & Draw Vault Map
  ctx.fillStyle = '#080b15';
  ctx.fillRect(0, 0, 640, 480);

  // Draw Tiles
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 20; c++) {
      const tile = MAP[r][c];
      const tx = c * 32, ty = r * 32;

      if (tile === 1) {
        // Wall
        ctx.fillStyle = '#161c2d';
        ctx.fillRect(tx, ty, 32, 32);
        ctx.strokeStyle = '#27334d';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx + 0.5, ty + 0.5, 31, 31);

        // Tech bevel highlight
        ctx.fillStyle = '#2a3854';
        ctx.fillRect(tx + 2, ty + 2, 28, 2);
      } else if (tile === 2) {
        // Exit Zone (Extraction Area)
        ctx.fillStyle = '#0e242b';
        ctx.fillRect(tx, ty, 32, 32);
        ctx.strokeStyle = '#1e5458';
        ctx.strokeRect(tx, ty, 32, 32);
      } else {
        // Floor tile with subtle grid pattern
        ctx.fillStyle = '#0b0f1d';
        ctx.fillRect(tx, ty, 32, 32);
        ctx.strokeStyle = '#141a2e';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx, ty, 32, 32);
      }
    }
  }

  // Draw Exit Zone High-Tech Grid & Holo Label (cols 1-3, rows 1-2)
  ctx.save();
  ctx.strokeStyle = '#48f0a0';
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, 96, 64);
  ctx.fillStyle = 'rgba(72, 240, 160, 0.12)';
  ctx.fillRect(32, 32, 96, 64);
  ctx.font = '700 10px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#48f0a0';
  ctx.textAlign = 'center';
  ctx.fillText('EXTRACTION', 80, 62);
  ctx.font = '600 8px "DM Sans", sans-serif';
  ctx.fillText('ESCAPE ZONE', 80, 74);
  ctx.restore();

  // Draw Pressure Switches
  drawSwitch(10 * 32 + 16, 11 * 32 + 16, game.switches.s1, '#5ce6f6', 'HOLD SWITCH A');
  drawSwitch(14 * 32 + 16, 11 * 32 + 16, game.switches.s1_exit, '#48f0a0', 'EXIT RELEASE');
  drawSwitch(8 * 32 + 16, 3 * 32 + 16, game.switches.s2, '#ffd05a', 'SWITCH B');

  // Draw Doors
  drawDoor(12, 11, game.doors.d1.open, 'DOOR A');
  drawDoor(12, 3, game.doors.d2.open, 'DOOR B');

  // Draw Lasers
  game.lasers.forEach(laser => drawLaser(laser, now));

  // Draw Treasures
  game.treasures.forEach((t, i) => {
    if (!t.collected) drawTreasure(t, now + i * 300);
  });

  // Draw Ghosts (in Round 2+)
  game.ghosts.forEach(ghost => drawGhost(ghost));

  // Draw Living Players
  game.players.forEach(p => {
    if (!p.escaped) drawPlayer(p);
  });

  // Draw Particles & Floating Texts
  renderParticles(dt);
  renderFloatingTexts(dt);
}

// ------------------------------------------------------------
// CANVAS DRAWING HELPERS
// ------------------------------------------------------------
function drawSwitch(x, y, pressed, color, label) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fillStyle = pressed ? color : '#11182c';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (pressed) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Label
  ctx.font = '700 8px "Space Grotesk", sans-serif';
  ctx.fillStyle = pressed ? '#ffffff' : color;
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y - 18);
  ctx.restore();
}

function drawDoor(col, row, isOpen, label) {
  const x = col * 32, y = row * 32;
  ctx.save();
  if (isOpen) {
    // Open door: sliding into wall
    ctx.fillStyle = 'rgba(72, 240, 160, 0.15)';
    ctx.fillRect(x, y, 32, 32);
    ctx.strokeStyle = '#48f0a0';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, 32, 32);

    ctx.font = '700 8px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#48f0a0';
    ctx.textAlign = 'center';
    ctx.fillText('OPEN', x + 16, y + 20);
  } else {
    // Heavy closed blast door
    ctx.fillStyle = '#21293d';
    ctx.fillRect(x, y, 32, 32);
    ctx.strokeStyle = '#ff486a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 32, 32);

    // Hazard cross-hatch stripes
    ctx.strokeStyle = 'rgba(255, 72, 106, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + 32, y + 32);
    ctx.moveTo(x + 32, y); ctx.lineTo(x, y + 32);
    ctx.stroke();

    ctx.font = '700 8px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#ff486a';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + 16, y + 19);
  }
  ctx.restore();
}

function drawLaser(laser, now) {
  ctx.save();

  // Emitter nodes at ends
  ctx.fillStyle = laser.active ? '#ff486a' : laser.warning ? '#ffd05a' : '#48f0a0';
  ctx.beginPath();
  ctx.arc(laser.x1, laser.y1, 4, 0, Math.PI * 2);
  ctx.arc(laser.x2, laser.y2, 4, 0, Math.PI * 2);
  ctx.fill();

  if (laser.active) {
    // Active pulsating laser beam
    ctx.shadowColor = '#ff2b54';
    ctx.shadowBlur = 12 + Math.sin(now * 0.02) * 4;
    ctx.strokeStyle = '#ff2b54';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(laser.x1, laser.y1);
    ctx.lineTo(laser.x2, laser.y2);
    ctx.stroke();

    // Hot white core
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(laser.x1, laser.y1);
    ctx.lineTo(laser.x2, laser.y2);
    ctx.stroke();

    // Occasional spark
    if (Math.random() < 0.25) {
      const t = Math.random();
      const sx = laser.x1 + (laser.x2 - laser.x1) * t;
      const sy = laser.y1 + (laser.y2 - laser.y1) * t;
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }
  } else if (laser.warning) {
    // Blinking warning before laser turns on
    if (Math.floor(now / 120) % 2 === 0) {
      ctx.strokeStyle = 'rgba(255, 208, 90, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(laser.x1, laser.y1);
      ctx.lineTo(laser.x2, laser.y2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawTreasure(t, now) {
  const bobY = t.y + Math.sin(now * 0.005) * 3;
  ctx.save();
  ctx.translate(t.x, bobY);

  if (t.isSpecial || t.type === 'crown') {
    // THE ROYAL GHOST CROWN (Grand Treasure behind Held Door!)
    ctx.shadowColor = '#ffd05a';
    ctx.shadowBlur = 14;

    // Golden halo
    ctx.fillStyle = 'rgba(255, 208, 90, 0.2)';
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fill();

    // Crown base & spikes
    ctx.fillStyle = '#ffd05a';
    ctx.beginPath();
    ctx.moveTo(-10, 6);
    ctx.lineTo(10, 6);
    ctx.lineTo(10, -2);
    ctx.lineTo(5, 2);
    ctx.lineTo(0, -7);
    ctx.lineTo(-5, 2);
    ctx.lineTo(-10, -2);
    ctx.closePath();
    ctx.fill();

    // Jewels on crown
    ctx.fillStyle = '#ff486a';
    ctx.beginPath();
    ctx.arc(0, -6, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5ce6f6';
    ctx.beginPath();
    ctx.arc(-8, -2, 1.5, 0, Math.PI * 2);
    ctx.arc(8, -2, 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '700 8px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#ffd05a';
    ctx.textAlign = 'center';
    ctx.fillText('+$350', 0, 17);
  } else if (t.type === 'gold' || t.type === 'chest') {
    // Gold Bar / Chest
    ctx.fillStyle = '#ffd05a';
    ctx.fillRect(-7, -5, 14, 10);
    ctx.strokeStyle = '#ffe894';
    ctx.lineWidth = 1;
    ctx.strokeRect(-7, -5, 14, 10);
  } else if (t.type === 'emerald') {
    // Emerald Gem
    ctx.fillStyle = '#48f0a0';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(6, -2);
    ctx.lineTo(4, 6);
    ctx.lineTo(-4, 6);
    ctx.lineTo(-6, -2);
    ctx.closePath();
    ctx.fill();
  } else if (t.type === 'ruby') {
    // Ruby Gem
    ctx.fillStyle = '#ff486a';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(6, 0);
    ctx.lineTo(0, 7);
    ctx.lineTo(-6, 0);
    ctx.closePath();
    ctx.fill();
  } else {
    // Diamond / Sapphire / Relic
    ctx.fillStyle = '#5ce6f6';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(p) {
  const x = p.renderX;
  const y = p.renderY;
  const isMe = session && p.id === session.id;

  ctx.save();

  // If currently zapped: draw electric shock lightning rings
  if (p.isZapped) {
    ctx.strokeStyle = '#ff486a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 16 + Math.random() * 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.ellipse(x, y + 10, 10, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
  ctx.lineWidth = isMe ? 2.5 : 1.5;
  ctx.stroke();

  // Visor eye indicating facing direction
  let vx = x, vy = y;
  if (p.dir === 'up') vy -= 5;
  else if (p.dir === 'down') vy += 5;
  else if (p.dir === 'left') vx -= 5;
  else if (p.dir === 'right') vx += 5;

  ctx.fillStyle = '#090b17';
  ctx.beginPath();
  ctx.arc(vx, vy, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Name Tag & Score
  ctx.font = '700 9px "Space Grotesk", sans-serif';
  ctx.fillStyle = isMe ? '#5ce6f6' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(p.name + (isMe ? ' (you)' : ''), x, y - 16);

  ctx.font = '600 8px "DM Sans", sans-serif';
  ctx.fillStyle = '#ffd05a';
  ctx.fillText(`$${p.score || 0}`, x, y - 7);

  ctx.restore();
}

function drawGhost(g) {
  ctx.save();
  ctx.globalAlpha = 0.55;

  // Ghostly aura
  ctx.shadowColor = '#5ce6f6';
  ctx.shadowBlur = 12;

  // Body
  ctx.fillStyle = '#a795fc';
  ctx.beginPath();
  ctx.arc(g.x, g.y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5ce6f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Floating ghost tag
  ctx.font = '700 9px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#a795fc';
  ctx.textAlign = 'center';
  ctx.fillText(`👻 GHOST: ${g.name}`, g.x, g.y - 14);

  ctx.restore();
}

function renderParticles(dt) {
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const pt = game.particles[i];
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.life -= dt * 1.5;
    if (pt.life <= 0) {
      game.particles.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = pt.life;
    ctx.fillStyle = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function renderFloatingTexts(dt) {
  for (let i = game.floatTexts.length - 1; i >= 0; i--) {
    const ft = game.floatTexts[i];
    ft.y -= 25 * dt;
    ft.life -= dt * 1.2;
    if (ft.life <= 0) {
      game.floatTexts.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = ft.life;
    ctx.font = '700 12px "Space Grotesk", sans-serif';
    ctx.fillStyle = ft.color;
    ctx.textAlign = 'center';
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.restore();
  }
}

// Start continuous animation loop
requestAnimationFrame(renderFrame);

// ============================================================
// KEYBOARD & TOUCH CONTROLS
// ============================================================
window.addEventListener('keydown', e => {
  if (['ArrowUp', 'KeyW'].includes(e.code)) { myInput.up = true; e.preventDefault(); }
  if (['ArrowDown', 'KeyS'].includes(e.code)) { myInput.down = true; e.preventDefault(); }
  if (['ArrowLeft', 'KeyA'].includes(e.code)) { myInput.left = true; e.preventDefault(); }
  if (['ArrowRight', 'KeyD'].includes(e.code)) { myInput.right = true; e.preventDefault(); }
});

window.addEventListener('keyup', e => {
  if (['ArrowUp', 'KeyW'].includes(e.code)) myInput.up = false;
  if (['ArrowDown', 'KeyS'].includes(e.code)) myInput.down = false;
  if (['ArrowLeft', 'KeyA'].includes(e.code)) myInput.left = false;
  if (['ArrowRight', 'KeyD'].includes(e.code)) myInput.right = false;
});

// Mobile On-Screen D-Pad
function bindDpad(btnId, dir) {
  const btn = $(btnId);
  if (!btn) return;

  const press = e => {
    e.preventDefault();
    myInput[dir] = true;
    btn.classList.add('pressed');
  };
  const release = e => {
    e.preventDefault();
    myInput[dir] = false;
    btn.classList.remove('pressed');
  };

  btn.addEventListener('touchstart', press, { passive: false });
  btn.addEventListener('touchend', release, { passive: false });
  btn.addEventListener('touchcancel', release, { passive: false });
  btn.addEventListener('mousedown', press);
  btn.addEventListener('mouseup', release);
  btn.addEventListener('mouseleave', release);
}

bindDpad('btn-up', 'up');
bindDpad('btn-down', 'down');
bindDpad('btn-left', 'left');
bindDpad('btn-right', 'right');

// Tap / Drag on Canvas to Walk
function handleCanvasPointer(e) {
  if (!game.active) return;
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const scaleX = 640 / rect.width;
  const scaleY = 480 / rect.height;

  myInput.targetX = (clientX - rect.left) * scaleX;
  myInput.targetY = (clientY - rect.top) * scaleY;
}

canvas.addEventListener('mousedown', e => { handleCanvasPointer(e); });
canvas.addEventListener('mousemove', e => { if (e.buttons === 1) handleCanvasPointer(e); });
canvas.addEventListener('touchstart', e => { e.preventDefault(); handleCanvasPointer(e); }, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); handleCanvasPointer(e); }, { passive: false });
window.addEventListener('mouseup', () => { myInput.targetX = null; myInput.targetY = null; });
window.addEventListener('touchend', () => { myInput.targetX = null; myInput.targetY = null; });
