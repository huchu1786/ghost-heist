'use strict';
const $ = id => document.getElementById(id);
let session = null, events = null, connected = false;
const entryError = $('entry-error'), lobbyError = $('lobby-error');
function showError(node, text) { node.textContent = text; }
function render(room) {
  connected = true; showError(lobbyError, '');
  $('room-code').textContent = room.code;
  $('count').textContent = `${room.players.length} / 5`;
  $('players').replaceChildren();
  room.players.forEach(player => {
    const row = document.createElement('div'); row.className = 'player';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = player.color; dot.style.color = player.color;
    const name = document.createElement('span'); name.className = 'player-name'; name.textContent = player.name + (player.id === session.id ? ' (you)' : '');
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = player.id === room.host ? 'HOST' : '';
    row.append(dot, name, badge); $('players').append(row);
  });
  const host = room.host === session.id;
  $('start').hidden = !host;
  $('status').textContent = host ? (room.players.length < 2 ? 'Waiting for at least one more player.' : 'Your crew is ready. The heist opens in a later stage.') : 'Waiting for the host.';
}
async function enter(action) {
  showError(entryError, ''); $('create').disabled = true; $('join').disabled = true;
  try {
    const response = await fetch(`/api/${action}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name:$('name').value, code:$('code').value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to connect.');
    session = data; $('entry').hidden = true; $('lobby').hidden = false;
    const params = new URLSearchParams(data); events = new EventSource('/api/events?' + params);
    events.onmessage = event => { try { render(JSON.parse(event.data)); } catch { showError(lobbyError, 'Could not read the lobby update.'); } };
    events.onerror = () => { connected = false; showError(lobbyError, 'Connection lost. Reconnecting… If this persists, leave and join again.'); };
  } catch (error) { showError(entryError, error.message || 'Connection failed. Please try again.'); }
  finally { $('create').disabled = false; $('join').disabled = false; }
}
$('create').onclick = () => enter('create'); $('join').onclick = () => enter('join');
$('code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('leave').onclick = async () => {
  const current = session; if (events) events.close(); events = null; session = null;
  if (current) fetch('/api/leave', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(current),keepalive:true}).catch(() => {});
  $('entry').hidden = false; $('lobby').hidden = true; showError(entryError, '');
};
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('room-code').textContent); $('copy').textContent = 'Copied!'; setTimeout(() => $('copy').textContent = 'Copy', 1800); } catch { $('copy').textContent = 'Copy code above'; } };
