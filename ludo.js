// Ludo rules engine (server-authoritative: dice are rolled here, so nobody can cheat).
// Seats go clockwise: 0 red (top-left), 1 green (top-right), 2 yellow (bottom-right), 3 blue (bottom-left).
// Token position: -1 = in yard, 0..50 = ring squares counted from its own start, 51..55 = home column, 56 = home (finished).
'use strict';
const crypto = require('crypto');

const FACES = ['😂', '🤪', '😈', '🤡', '👻', '💩', '🦄', '🐸', '🥸', '😎', '🤖', '👽', '🐵', '🥴', '🤓', '😜'];
const SEATS = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };     // 2 players sit opposite each other
const abs = (seat, p) => (13 * seat + p) % 52;
const safe = a => a % 13 === 0 || a % 13 === 8;                    // start squares and star squares
const clip = (s, n) => String(s || '').trim().slice(0, n);

const fresh = (lobby = [], seq = 0) => ({ phase: 'lobby', lobby, players: [], turn: 0, dice: 0, last: null, movable: [], sixes: 0, winner: null, seq, evs: [] });
const emit = (g, evs) => { g.evs = evs.map(e => ({ seq: ++g.seq, ...e })); };

const view = g => ({
  phase: g.phase, faces: FACES, lobby: g.lobby, turn: g.turn, dice: g.dice, last: g.last, movable: g.movable, winner: g.winner, seq: g.seq, evs: g.evs,
  players: g.players.map(p => ({ seat: p.seat, cid: p.cid, name: p.name, face: p.face, tokens: p.tokens, out: p.out, away: p.away })),
});

function next(g) {                                                  // pass the turn to the next player who is still here
  g.sixes = 0; g.dice = 0; g.movable = [];
  for (let i = 0; i < g.players.length; i++) {
    g.turn = (g.turn + 1) % g.players.length;
    const p = g.players[g.turn];
    if (!p.out && !p.away) return;
  }
}

const movableOf = (p, d) => p.tokens.map((t, i) => (t === -1 ? d === 6 : t + d <= 56) ? i : -1).filter(i => i >= 0);

function doMove(g, idx, evs) {
  const p = g.players[g.turn], d = g.dice, t = p.tokens[idx], to = t === -1 ? 0 : t + d, caps = [];
  p.tokens[idx] = to;
  if (to <= 50) {
    const a = abs(p.seat, to);
    if (!safe(a)) for (const o of g.players) if (o !== p && !o.out) o.tokens.forEach((q, i) => {
      if (q >= 0 && q <= 50 && abs(o.seat, q) === a) { o.tokens[i] = -1; caps.push({ name: o.name, face: o.face, seat: o.seat }); }
    });
  }
  const fin = to === 56;
  evs.push({ type: 'move', cid: p.cid, name: p.name, face: p.face, seat: p.seat, token: idx, caps, fin });
  g.dice = 0; g.movable = [];
  if (p.tokens.every(x => x === 56)) {
    g.phase = 'done'; g.winner = { cid: p.cid, name: p.name, face: p.face, seat: p.seat };
    evs.push({ type: 'win', name: p.name, face: p.face, seat: p.seat });
    return;
  }
  if (d === 6 || caps.length || fin) { if (d !== 6) g.sixes = 0; } else next(g);   // 6, a capture, or reaching home gives another roll
}

// me = { cid, name }. Returns an error string, or null when the action was applied.
function act(g, me, body, isHost) {
  const a = String(body.a || ''), evs = [];
  const inLobby = g.lobby.find(p => p.cid === me.cid), seated = g.players.find(p => p.cid === me.cid && !p.out);
  const taken = f => g.lobby.some(p => p.face === f && p.cid !== me.cid);
  const okFace = f => FACES.includes(f) && !taken(f);

  if (a === 'join' || a === 'face') {
    if (g.phase !== 'lobby') return 'A game is already running.';
    if (inLobby) { if (okFace(body.face)) inLobby.face = body.face; }
    else {
      if (a === 'face') return 'Join the game first.';
      if (g.lobby.length >= 4) return 'The table is full (4 players max).';
      g.lobby.push({ cid: me.cid, name: clip(me.name, 24) || 'Guest', face: okFace(body.face) ? body.face : FACES.find(f => !taken(f)) });
    }
    g.seq++; return null;
  }
  if (a === 'leave') { if (g.phase === 'lobby') { g.lobby = g.lobby.filter(p => p.cid !== me.cid); g.seq++; } return null; }
  if (a === 'start') {
    if (g.phase !== 'lobby') return 'A game is already running.';
    if (!inLobby) return 'Join the game first.';
    const n = g.lobby.length; if (n < 2) return 'You need at least 2 players.';
    g.players = g.lobby.map((p, i) => ({ seat: SEATS[n][i], cid: p.cid, name: p.name, face: p.face, tokens: [-1, -1, -1, -1], out: false, away: false }));
    Object.assign(g, { phase: 'play', turn: 0, dice: 0, last: null, movable: [], sixes: 0, winner: null });
    emit(g, [{ type: 'start', n }]); return null;
  }
  if (a === 'stop') {                                              // back to the lobby, keeping the same players and faces
    if (g.phase === 'lobby') return null;
    if (!isHost && !seated && !inLobby) return 'Only players or the host can stop the game.';
    const keep = g.players.filter(p => !p.out && !p.away).map(p => ({ cid: p.cid, name: p.name, face: p.face }));
    Object.assign(g, fresh(keep, g.seq)); emit(g, [{ type: 'stop' }]); return null;
  }

  if (g.phase !== 'play') return 'No game is running.';
  const p = g.players[g.turn];
  if (!p || p.cid !== me.cid) return "It's not your turn.";
  if (a === 'roll') {
    if (g.dice) return 'Pick a token to move.';
    const d = crypto.randomInt(1, 7);
    g.last = { cid: p.cid, name: p.name, dice: d };
    evs.push({ type: 'roll', cid: p.cid, name: p.name, dice: d });
    g.sixes = d === 6 ? g.sixes + 1 : 0;
    if (g.sixes >= 3) { evs.push({ type: 'forfeit', name: p.name }); next(g); }          // three 6s in a row: turn is lost
    else {
      g.dice = d; g.movable = movableOf(p, d);
      if (!g.movable.length) { evs.push({ type: 'nomove', name: p.name }); next(g); }
      else if (g.movable.length === 1) doMove(g, g.movable[0], evs);                      // only one choice: move it
    }
    emit(g, evs); return null;
  }
  if (a === 'move') {
    const idx = Number(body.token);
    if (!g.dice) return 'Roll the dice first.';
    if (!g.movable.includes(idx)) return 'That token cannot move.';
    doMove(g, idx, evs); emit(g, evs); return null;
  }
  return 'Unknown action.';
}

function setAway(g, cid, away) {                                    // a player's connection dropped or came back
  if (g.phase === 'lobby') {
    if (!away || !g.lobby.some(p => p.cid === cid)) return false;
    g.lobby = g.lobby.filter(p => p.cid !== cid); g.seq++; return true;
  }
  const p = g.players.find(x => x.cid === cid);
  if (!p || p.out || p.away === away) return false;
  p.away = away;
  if (away && g.phase === 'play' && g.players[g.turn] === p) { next(g); emit(g, [{ type: 'skip', name: p.name }]); } else g.seq++;
  return true;
}

function out(g, cid) {                                              // the host removed this person
  if (g.phase === 'lobby') { const n = g.lobby.length; g.lobby = g.lobby.filter(p => p.cid !== cid); if (g.lobby.length !== n) g.seq++; return g.lobby.length !== n; }
  const p = g.players.find(x => x.cid === cid);
  if (!p || p.out) return false;
  p.out = true; p.tokens = [-1, -1, -1, -1];
  const left = g.players.filter(x => !x.out);
  if (g.phase === 'play') {
    if (left.length <= 1) {
      g.phase = 'done'; g.dice = 0; g.movable = [];
      const w = left[0]; g.winner = w ? { cid: w.cid, name: w.name, face: w.face, seat: w.seat } : null;
      emit(g, w ? [{ type: 'win', name: w.name, face: w.face, seat: w.seat }] : [{ type: 'stop' }]);
    } else if (g.players[g.turn] === p) { next(g); emit(g, [{ type: 'skip', name: p.name }]); } else g.seq++;
  } else g.seq++;
  return true;
}

function rename(g, cid, name) {
  let ch = false;
  for (const p of [...g.lobby, ...g.players]) if (p.cid === cid && p.name !== name) { p.name = name; ch = true; }
  if (ch) g.seq++;
  return ch;
}

module.exports = { fresh, view, act, setAway, out, rename, FACES };
