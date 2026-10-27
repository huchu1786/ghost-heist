'use strict';

const $ = id => document.getElementById(id);

// Session & Networking state
let session = null;
let sseSource = null;
let socket = null;
let currentRoom = null;
let soundEnabled = true;
let audioCtx = null;
let ambientOsc = null;
let ambientGain = null;

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
  rings: [],
  confetti: [],
  toastTimer: null,
  lastTickTime: performance.now(),
  lastMoveSent: 0,
  shakeIntensity: 0
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
const confettiCanvas = $('confetti-canvas');
const confCtx = confettiCanvas ? confettiCanvas.getContext('2d') : null;

function showError(node, text) {
  if (node) node.textContent = text;
}

function showToast(text, duration = 2400) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(game.toastTimer);
  game.toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

// Random Codename Generator
const CODENAMES = ['Phantom', 'Cipher', 'Viper', 'GhostFox', 'Specter', 'ApexThief', 'Nova', 'Echo', 'NeonWolf', 'ZeroCool', 'ShadowEdge', 'Raven'];
$('btn-random-name').onclick = () => {
  const random = CODENAMES[Math.floor(Math.random() * CODENAMES.length)];
  $('name').value = random;
};

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

function startAmbientHum() {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx || ambientOsc) return;
  try {
    ambientOsc = ctx.createOscillator();
    ambientGain = ctx.createGain();
    ambientOsc.type = 'sawtooth';
    ambientOsc.frequency.setValueAtTime(55, ctx.currentTime); // Low A1 drone
    ambientGain.gain.setValueAtTime(0.015, ctx.currentTime);
    ambientOsc.connect(ambientGain);
    ambientGain.connect(ctx.destination);
    ambientOsc.start();
  } catch {}
}

function stopAmbientHum() {
  if (ambientOsc) {
    try {
      ambientOsc.stop();
      ambientOsc.disconnect();
    } catch {}
    ambientOsc = null;
    ambientGain = null;
  }
}

function playSound(type) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  try {
    if (type === 'pickup') {
      // Crisp 3-note crystalline arpeggio (C5 -> E5 -> G5)
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.05);
        gain.gain.setValueAtTime(0.2, now + idx * 0.05);
        gain.gain.exponentialRampToValueAtTime(0.005, now + idx * 0.05 + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.05);
        osc.stop(now + idx * 0.05 + 0.16);
      });
    } else if (type === 'crown') {
      // Grand 5-note royal fanfare
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.07);
        gain.gain.setValueAtTime(0.25, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.005, now + i * 0.07 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + i * 0.07 + 0.35);
      });
    } else if (type === 'switch') {
      // Mechanical thud + electrical surge
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(340, now + 0.08);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'door') {
      // Hydraulic hiss & metal slide
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.linearRampToValueAtTime(70, now + 0.22);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'zap') {
      // Sizzling electric zap
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.linearRampToValueAtTime(60, now + 0.25);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
      if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
    } else if (type === 'escape') {
      // Triumphant 4-chord victory fanfare
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.09);
        gain.gain.setValueAtTime(0.28, now + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.09 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + i * 0.09 + 0.4);
      });
    } else if (type === 'tick') {
      // High-tech countdown heartbeat tick
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(920, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    }
  } catch {}
}

function toggleAudio() {
  soundEnabled = !soundEnabled;
  const icon = soundEnabled ? '🔊' : '🔇';
  $('sound-btn').textContent = icon;
  $('sound-btn-header').textContent = icon;
  if (soundEnabled) {
    getAudioContext();
    if (game.active) startAmbientHum();
  } else {
    stopAmbientHum();
  }
}
$('sound-btn').onclick = toggleAudio;
$('sound-btn-header').onclick = toggleAudio;

// ============================================================
// WEBSOCKET & SSE MESSAGING
// ============================================================
function connectTransport() {
  if (!session) return;

  // 1. SSE Fallback
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

  // 2. Native WebSocket
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
        stopAmbientHum();
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
    let nameVal = $('name').value.trim();
    if (!nameVal) {
      nameVal = CODENAMES[Math.floor(Math.random() * CODENAMES.length)];
      $('name').value = nameVal;
    }
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

$('leave').onclick = () => leaveRoom();
$('results-leave').onclick = () => leaveRoom();

function leaveRoom() {
  stopAmbientHum();
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
    $('copy-text').textContent = 'Copied!';
    setTimeout(() => { $('copy-text').textContent = 'Copy'; }, 1800);
  } catch {
    $('copy-text').textContent = 'Code above';
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
  game.rings = [];
  game.doors = { d1: { open: false }, d2: { open: false } };
  game.switches = { s1: false, s1_exit: false, s2: false };

  showScreen('game');
  $('hud-round-tag').textContent = `R${game.round}`;
  $('hud-timer').textContent = `${game.timeLeft}s`;
  $('hud-timer').classList.remove('urgent');
  $('hud-score').textContent = '$0';

  startAmbientHum();
  showToast(game.round === 1 ? 'VAULT INFILTRATION STARTED! 30s ON THE CLOCK!' : `ROUND ${game.round}: GHOST TIMELINES ACTIVE!`);
  playSound('switch');
}

function applyGameTick(tick) {
  if (!game.active) {
    game.active = true;
    showScreen('game');
    startAmbientHum();
  }

  // Update timer
  if (game.timeLeft !== tick.timeLeft) {
    if (tick.timeLeft <= 10 && tick.timeLeft > 0) {
      playSound('tick');
    }
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
      // Trigger shockwave ring on switch
      if (tick.switches.s1) addExpandingRing(10 * 32 + 16, 11 * 32 + 16, '#00f3ff');
      if (tick.switches.s1_exit) addExpandingRing(14 * 32 + 16, 11 * 32 + 16, '#00f59b');
      if (tick.switches.s2) addExpandingRing(8 * 32 + 16, 3 * 32 + 16, '#ffbe0b');
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
          showToast(`👑 ${ev.name} LOOTED THE ROYAL GHOST CROWN (+$${ev.val})!`, 3200);
        } else {
          playSound('pickup');
          showToast(`💰 ${ev.name} grabbed +$${ev.val}!`);
        }
        const tObj = game.treasures.find(x => x.id === ev.treasureId);
        if (tObj) {
          addFloatingText(`+$${ev.val}`, tObj.x, tObj.y, '#ffbe0b');
          addSparkleParticles(tObj.x, tObj.y, ev.isSpecial ? '#ffbe0b' : '#00f3ff', 24);
        }
      } else if (ev.type === 'zapped') {
        playSound('zap');
        game.shakeIntensity = 10;
        showToast(`⚡ ${ev.name} was zapped by a laser grid! (-$50)`);
        const pObj = game.players.get(ev.playerId);
        if (pObj) {
          addFloatingText('-$50 ZAPPED!', pObj.renderX, pObj.renderY, '#ff2a55');
          addSparkleParticles(pObj.renderX, pObj.renderY, '#ff2a55', 24);
        }
      } else if (ev.type === 'escaped') {
        playSound('escape');
        showToast(`🚀 ${ev.name} EXTRACTED SAFELY (+200 pts)!`, 2500);
        const pObj = game.players.get(ev.playerId);
        if (pObj) {
          addFloatingText('EXTRACTED! +200', pObj.renderX, pObj.renderY, '#00f59b');
          addExpandingRing(pObj.renderX, pObj.renderY, '#00f59b');
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
  stopAmbientHum();
  showScreen('results');

  const isHost = currentRoom && currentRoom.host === session?.id;
  $('play-again').hidden = !isHost;
  $('results-lobby').hidden = !isHost;
  $('results-waiting').hidden = isHost;

  $('res-round').textContent = data.round || 1;
  $('res-loot').textContent = `$${(data.teamScore || 0).toLocaleString()}`;
  const escapedCount = (data.scoreboard || []).filter(p => p.escaped).length;
  $('res-escaped').textContent = `${escapedCount} / ${(data.scoreboard || []).length}`;

  // Set Rank Letter and Titles
  const rank = data.rank || (escapedCount > 0 ? 'A' : 'B');
  $('res-rank').textContent = rank;
  $('results-title').innerHTML = `Vault <em>${data.rankTitle || 'Plundered.'}</em>`;

  if (escapedCount > 0) {
    spawnConfetti();
    playSound('escape');
  }

  // Awards Podium
  $('award-looter').textContent = data.awards?.topLooter || 'None';
  $('award-speed').textContent = data.awards?.speedDemon ? `${data.awards.speedDemon}` : 'None';
  $('award-switch').textContent = data.awards?.switchHero || 'None';

  // Scoreboard
  const container = $('results-players');
  container.replaceChildren();
  (data.scoreboard || []).forEach((p, rankIdx) => {
    const row = document.createElement('div');
    row.className = 'player';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color;
    dot.style.color = p.color;

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = `#${rankIdx + 1} ${p.name} (${p.treasuresCount} treasures, ${p.escaped ? 'Escaped ✓' : 'Caught'})`;

    const score = document.createElement('strong');
    score.style.color = '#ffbe0b';
    score.textContent = `$${p.score}`;

    row.append(dot, name, score);
    container.append(row);
  });

  if (data.hasGhosts) {
    $('ghost-tip').textContent = 'Your footsteps are saved! In Round 2, your past ghost will walk in sync and hold Switch A open for the Royal Crown!';
  }
}

// Confetti System for Results Screen
function spawnConfetti() {
  if (!confettiCanvas) return;
  confettiCanvas.width = confettiCanvas.offsetWidth;
  confettiCanvas.height = confettiCanvas.offsetHeight;
  game.confetti = [];
  const palette = ['#00f3ff', '#00f59b', '#ffbe0b', '#a881fc', '#ff2a55'];
  for (let i = 0; i < 90; i++) {
    game.confetti.push({
      x: Math.random() * confettiCanvas.width,
      y: -20 - Math.random() * 80,
      vx: (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 5,
      size: 4 + Math.random() * 6,
      color: palette[Math.floor(Math.random() * palette.length)],
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.2
    });
  }
}

function updateConfetti() {
  if (!confCtx || !game.confetti.length) return;
  confCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  for (let i = game.confetti.length - 1; i >= 0; i--) {
    const c = game.confetti[i];
    c.x += c.vx;
    c.y += c.vy;
    c.rot += c.vrot;
    if (c.y > confettiCanvas.height) {
      game.confetti.splice(i, 1);
      continue;
    }
    confCtx.save();
    confCtx.translate(c.x, c.y);
    confCtx.rotate(c.rot);
    confCtx.fillStyle = c.color;
    confCtx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size);
    confCtx.restore();
  }
}

// ============================================================
// MOVEMENT & COLLISION ENGINE
// ============================================================
function isWalkable(x, y, radius) {
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
      // Safety guarantee: allow exiting if player is inside vault room
      if (x < 12 * 32) return false;
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

  const speed = 148;
  let dx = 0, dy = 0;

  if (myInput.up) dy -= 1;
  if (myInput.down) dy += 1;
  if (myInput.left) dx -= 1;
  if (myInput.right) dx += 1;

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
    if (Math.abs(dx) > Math.abs(dy)) {
      me.dir = dx > 0 ? 'right' : 'left';
    } else {
      me.dir = dy > 0 ? 'down' : 'up';
    }

    const moveDist = speed * dt;
    const targetX = me.x + dx * moveDist;
    const targetY = me.y + dy * moveDist;

    // Corner sliding
    if (isWalkable(targetX, me.y, 11)) me.x = targetX;
    if (isWalkable(me.x, targetY, 11)) me.y = targetY;

    // Running dust particle occasionally
    if (Math.random() < 0.25) {
      addDustParticle(me.x, me.y + 8);
    }

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

// Particle & FX Helpers
function addFloatingText(text, x, y, color) {
  game.floatTexts.push({ text, x, y, color, life: 1.0 });
}

function addSparkleParticles(x, y, color, count = 16) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd = 25 + Math.random() * 75;
    game.particles.push({
      x, y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      color,
      size: 2 + Math.random() * 3.5,
      life: 1.0
    });
  }
}

function addDustParticle(x, y) {
  game.particles.push({
    x: x + (Math.random() - 0.5) * 6,
    y: y + (Math.random() - 0.5) * 3,
    vx: (Math.random() - 0.5) * 8,
    vy: (Math.random() - 0.5) * 8,
    color: 'rgba(255, 255, 255, 0.2)',
    size: 2,
    life: 0.4
  });
}

function addExpandingRing(x, y, color) {
  game.rings.push({ x, y, radius: 4, maxRadius: 36, color, life: 1.0 });
}

// ============================================================
// MAIN RENDER LOOP (60 FPS)
// ============================================================
function renderFrame(now) {
  requestAnimationFrame(renderFrame);
  const dt = Math.min(0.1, (now - game.lastTickTime) / 1000);
  game.lastTickTime = now;

  if (game.confetti.length) updateConfetti();

  if (!game.active) return;

  // 1. Update local movement
  updateLocalPlayer(dt);

  // 2. Interpolate remote players
  game.players.forEach(p => {
    if (p.id !== session?.id && p.targetX !== undefined) {
      p.renderX += (p.targetX - p.renderX) * 0.35;
      p.renderY += (p.targetY - p.renderY) * 0.35;
    } else {
      p.renderX = p.x;
      p.renderY = p.y;
    }
  });

  // Screen shake decay
  ctx.save();
  if (game.shakeIntensity > 0) {
    const sx = (Math.random() - 0.5) * game.shakeIntensity;
    const sy = (Math.random() - 0.5) * game.shakeIntensity;
    ctx.translate(sx, sy);
    game.shakeIntensity = Math.max(0, game.shakeIntensity - dt * 25);
  }

  // 3. Clear canvas & Render Vault
  ctx.fillStyle = '#070a14';
  ctx.fillRect(0, 0, 640, 480);

  // Draw Vault Tiles
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 20; c++) {
      const tile = MAP[r][c];
      const tx = c * 32, ty = r * 32;

      if (tile === 1) {
        // High-Tech Cyber Security Wall
        ctx.fillStyle = '#141a2e';
        ctx.fillRect(tx, ty, 32, 32);

        // Top metallic bevel
        ctx.fillStyle = '#243050';
        ctx.fillRect(tx + 2, ty + 2, 28, 3);

        ctx.strokeStyle = '#1e263d';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx + 0.5, ty + 0.5, 31, 31);
      } else if (tile === 2) {
        // Extraction Escape Zone
        ctx.fillStyle = '#081c1c';
        ctx.fillRect(tx, ty, 32, 32);
        ctx.strokeStyle = '#113a38';
        ctx.strokeRect(tx, ty, 32, 32);
      } else {
        // Carbon plating floor with rivets
        ctx.fillStyle = '#0a0e1c';
        ctx.fillRect(tx, ty, 32, 32);
        ctx.strokeStyle = '#12182c';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx, ty, 32, 32);

        // Subtle corner rivet
        ctx.fillStyle = '#19223c';
        ctx.fillRect(tx + 2, ty + 2, 1.5, 1.5);
      }
    }
  }

  // Draw Extraction Teleporter Beacon (Cols 1-3, Rows 1-2)
  drawExtractionZone(now);

  // Draw Pressure Switches
  drawSwitch(10 * 32 + 16, 11 * 32 + 16, game.switches.s1, '#00f3ff', 'HOLD SWITCH A');
  drawSwitch(14 * 32 + 16, 11 * 32 + 16, game.switches.s1_exit, '#00f59b', 'EXIT RELEASE');
  drawSwitch(8 * 32 + 16, 3 * 32 + 16, game.switches.s2, '#ffbe0b', 'SWITCH B');

  // Draw Doors
  drawDoor(12, 11, game.doors.d1.open, 'DOOR A');
  drawDoor(12, 3, game.doors.d2.open, 'DOOR B');

  // Draw Lasers
  game.lasers.forEach(laser => drawLaser(laser, now));

  // Draw Treasures
  game.treasures.forEach((t, i) => {
    if (!t.collected) drawTreasure(t, now + i * 350);
  });

  // Draw Ghosts (Round 2+)
  game.ghosts.forEach(ghost => drawGhost(ghost, now));

  // Draw Living Players
  game.players.forEach(p => {
    if (!p.escaped) drawPlayer(p, now);
  });

  // Draw FX Rings, Particles, & Floating Texts
  renderRings(dt);
  renderParticles(dt);
  renderFloatingTexts(dt);

  ctx.restore();
}

// ------------------------------------------------------------
// CANVAS DRAWING HELPERS
// ------------------------------------------------------------
function drawExtractionZone(now) {
  ctx.save();
  // Glowing extraction rectangle
  ctx.strokeStyle = '#00f59b';
  ctx.lineWidth = 2;
  ctx.strokeRect(32, 32, 96, 64);
  ctx.fillStyle = 'rgba(0, 245, 155, 0.12)';
  ctx.fillRect(32, 32, 96, 64);

  // Rotating teleporter ring in center
  ctx.translate(80, 64);
  ctx.rotate(now * 0.002);
  ctx.strokeStyle = 'rgba(0, 245, 155, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Extraction text
  ctx.save();
  ctx.font = '800 11px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#00f59b';
  ctx.textAlign = 'center';
  ctx.shadowColor = '#00f59b';
  ctx.shadowBlur = 8;
  ctx.fillText('EXTRACTION', 80, 60);
  ctx.font = '700 8px "DM Sans", sans-serif';
  ctx.fillText('ESCAPE ZONE', 80, 74);
  ctx.restore();
}

function drawSwitch(x, y, pressed, color, label) {
  ctx.save();
  ctx.translate(x, y);

  // Outer bezel
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fillStyle = pressed ? color : '#0f1528';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (pressed) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Label
  ctx.font = '800 8px "Space Grotesk", sans-serif';
  ctx.fillStyle = pressed ? '#ffffff' : color;
  ctx.textAlign = 'center';
  ctx.shadowColor = color;
  ctx.shadowBlur = pressed ? 10 : 0;
  ctx.fillText(label, 0, -18);
  ctx.restore();
}

function drawDoor(col, row, isOpen, label) {
  const x = col * 32, y = row * 32;
  ctx.save();
  if (isOpen) {
    // Open door: recessed with glowing clearance
    ctx.fillStyle = 'rgba(0, 245, 155, 0.15)';
    ctx.fillRect(x, y, 32, 32);
    ctx.strokeStyle = '#00f59b';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, 32, 32);

    ctx.font = '800 8px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#00f59b';
    ctx.textAlign = 'center';
    ctx.fillText('CLEAR', x + 16, y + 20);
  } else {
    // Armored blast door with hazard cross
    ctx.fillStyle = '#1c2438';
    ctx.fillRect(x, y, 32, 32);
    ctx.strokeStyle = '#ff2a55';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, 32, 32);

    // Hazard chevrons
    ctx.strokeStyle = 'rgba(255, 42, 85, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + 32, y + 32);
    ctx.moveTo(x + 32, y); ctx.lineTo(x, y + 32);
    ctx.stroke();

    ctx.font = '800 8px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#ff2a55';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + 16, y + 19);
  }
  ctx.restore();
}

function drawLaser(laser, now) {
  ctx.save();
  // Wall emitter nodes
  ctx.fillStyle = laser.active ? '#ff2a55' : laser.warning ? '#ffbe0b' : '#00f59b';
  ctx.beginPath();
  ctx.arc(laser.x1, laser.y1, 4.5, 0, Math.PI * 2);
  ctx.arc(laser.x2, laser.y2, 4.5, 0, Math.PI * 2);
  ctx.fill();

  if (laser.active) {
    // Multi-layer laser bloom
    ctx.shadowColor = '#ff003c';
    ctx.shadowBlur = 16 + Math.sin(now * 0.03) * 6;
    ctx.strokeStyle = '#ff1744';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(laser.x1, laser.y1);
    ctx.lineTo(laser.x2, laser.y2);
    ctx.stroke();

    // Hot white core
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(laser.x1, laser.y1);
    ctx.lineTo(laser.x2, laser.y2);
    ctx.stroke();

    // Occasional sparks
    if (Math.random() < 0.3) {
      const t = Math.random();
      const sx = laser.x1 + (laser.x2 - laser.x1) * t;
      const sy = laser.y1 + (laser.y2 - laser.y1) * t;
      addSparkleParticles(sx, sy, '#fff', 1);
    }
  } else if (laser.warning) {
    // Blinking danger warning line
    if (Math.floor(now / 110) % 2 === 0) {
      ctx.strokeStyle = 'rgba(255, 190, 11, 0.85)';
      ctx.lineWidth = 1.5;
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
  const bobY = t.y + Math.sin(now * 0.005) * 3.5;
  ctx.save();
  ctx.translate(t.x, bobY);

  if (t.isSpecial || t.type === 'crown') {
    // THE ROYAL GHOST CROWN ($350)
    ctx.shadowColor = '#ffbe0b';
    ctx.shadowBlur = 18;

    // Golden halo aura
    ctx.fillStyle = 'rgba(255, 190, 11, 0.22)';
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fill();

    // Crown Body
    ctx.fillStyle = '#ffbe0b';
    ctx.beginPath();
    ctx.moveTo(-11, 7);
    ctx.lineTo(11, 7);
    ctx.lineTo(11, -2);
    ctx.lineTo(6, 2);
    ctx.lineTo(0, -8);
    ctx.lineTo(-6, 2);
    ctx.lineTo(-11, -2);
    ctx.closePath();
    ctx.fill();

    // Jewels
    ctx.fillStyle = '#ff2a55';
    ctx.beginPath();
    ctx.arc(0, -7, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#00f3ff';
    ctx.beginPath();
    ctx.arc(-8, -2, 1.8, 0, Math.PI * 2);
    ctx.arc(8, -2, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Floating value pill
    ctx.font = '800 9px "Space Grotesk", sans-serif';
    ctx.fillStyle = '#ffbe0b';
    ctx.textAlign = 'center';
    ctx.fillText('+$350 CROWN', 0, 19);
  } else if (t.type === 'gold' || t.type === 'chest') {
    ctx.fillStyle = '#ffbe0b';
    ctx.fillRect(-7, -5, 14, 10);
    ctx.strokeStyle = '#ffe484';
    ctx.lineWidth = 1;
    ctx.strokeRect(-7, -5, 14, 10);
  } else if (t.type === 'emerald') {
    ctx.fillStyle = '#00f59b';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(7, -2);
    ctx.lineTo(5, 7);
    ctx.lineTo(-5, 7);
    ctx.lineTo(-7, -2);
    ctx.closePath();
    ctx.fill();
  } else if (t.type === 'ruby') {
    ctx.fillStyle = '#ff2a55';
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(7, 0);
    ctx.lineTo(0, 8);
    ctx.lineTo(-7, 0);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = '#00f3ff';
    ctx.beginPath();
    ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(p, now) {
  const x = p.renderX;
  const y = p.renderY;
  const isMe = session && p.id === session.id;

  ctx.save();

  // Electric shock arcs if zapped
  if (p.isZapped) {
    ctx.strokeStyle = '#ff2a55';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 16 + Math.random() * 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Soft drop shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.ellipse(x, y + 10, 10, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Infiltrator Body
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(255, 255, 255, 0.65)';
  ctx.lineWidth = isMe ? 2.5 : 1.5;
  ctx.stroke();

  // Glowing Visor facing movement direction
  let vx = x, vy = y;
  if (p.dir === 'up') vy -= 5;
  else if (p.dir === 'down') vy += 5;
  else if (p.dir === 'left') vx -= 5;
  else if (p.dir === 'right') vx += 5;

  ctx.fillStyle = '#060a14';
  ctx.beginPath();
  ctx.arc(vx, vy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = isMe ? '#00f3ff' : '#ffffff';
  ctx.beginPath();
  ctx.arc(vx, vy, 2, 0, Math.PI * 2);
  ctx.fill();

  // Name Tag & Live Balance
  ctx.font = '800 9px "Space Grotesk", sans-serif';
  ctx.fillStyle = isMe ? '#00f3ff' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.shadowColor = isMe ? '#00f3ff' : 'transparent';
  ctx.shadowBlur = isMe ? 6 : 0;
  ctx.fillText(p.name + (isMe ? ' (you)' : ''), x, y - 16);

  ctx.font = '700 8px "DM Sans", sans-serif';
  ctx.fillStyle = '#ffbe0b';
  ctx.fillText(`$${p.score || 0}`, x, y - 7);

  ctx.restore();
}

function drawGhost(g, now) {
  ctx.save();
  ctx.globalAlpha = 0.55;

  // Ethereal purple/cyan glow
  ctx.shadowColor = '#a881fc';
  ctx.shadowBlur = 14;

  const bobY = g.y + Math.sin(now * 0.006) * 2;

  // Body
  ctx.fillStyle = '#a881fc';
  ctx.beginPath();
  ctx.arc(g.x, bobY, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#00f3ff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ghostly Visor
  ctx.fillStyle = '#00f3ff';
  ctx.beginPath();
  ctx.arc(g.x, bobY - 2, 3, 0, Math.PI * 2);
  ctx.fill();

  // Floating ghost badge
  ctx.font = '800 9px "Space Grotesk", sans-serif';
  ctx.fillStyle = '#a881fc';
  ctx.textAlign = 'center';
  ctx.fillText(`👻 GHOST: ${g.name}`, g.x, bobY - 14);

  // Ectoplasm trail particle occasionally
  if (Math.random() < 0.2) {
    game.particles.push({
      x: g.x,
      y: bobY,
      vx: (Math.random() - 0.5) * 10,
      vy: (Math.random() - 0.5) * 10,
      color: 'rgba(168, 129, 252, 0.4)',
      size: 3,
      life: 0.6
    });
  }

  ctx.restore();
}

function renderRings(dt) {
  for (let i = game.rings.length - 1; i >= 0; i--) {
    const r = game.rings[i];
    r.radius += (r.maxRadius - r.radius) * 8 * dt;
    r.life -= dt * 2;
    if (r.life <= 0) {
      game.rings.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = r.life;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
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
    ft.y -= 28 * dt;
    ft.life -= dt * 1.2;
    if (ft.life <= 0) {
      game.floatTexts.splice(i, 1);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = ft.life;
    ctx.font = '800 12px "Space Grotesk", sans-serif';
    ctx.fillStyle = ft.color;
    ctx.textAlign = 'center';
    ctx.shadowColor = ft.color;
    ctx.shadowBlur = 8;
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

// Mobile On-Screen D-Pad with Haptics
function bindDpad(btnId, dir) {
  const btn = $(btnId);
  if (!btn) return;

  const press = e => {
    e.preventDefault();
    myInput[dir] = true;
    btn.classList.add('pressed');
    if (navigator.vibrate) navigator.vibrate(15);
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

canvas.addEventListener('mousedown', handleCanvasPointer);
canvas.addEventListener('mousemove', e => { if (e.buttons === 1) handleCanvasPointer(e); });
canvas.addEventListener('touchstart', e => { e.preventDefault(); handleCanvasPointer(e); }, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); handleCanvasPointer(e); }, { passive: false });
window.addEventListener('mouseup', () => { myInput.targetX = null; myInput.targetY = null; });
window.addEventListener('touchend', () => { myInput.targetX = null; myInput.targetY = null; });
