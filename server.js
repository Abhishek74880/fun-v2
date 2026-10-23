// Fun time: tiny zero-dependency server (Node 16+). Rooms, video upload, Range streaming, SSE sync.
const ludo = require('./ludo');
const http = require('http'), os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = (Number(process.env.MAX_MB) || 3072) * 1048576;
const TTL = 6 * 3600 * 1000;                       // rooms and videos expire after 6h idle
const UP = path.join(__dirname, 'uploads');
fs.rmSync(UP, { recursive: true, force: true }); fs.mkdirSync(UP);
const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const rooms = new Map();

const cur = r => r.state.playing ? r.state.time + (Date.now() - r.state.at) / 1000 : r.state.time;
const snap = r => ({ playing: r.state.playing, time: cur(r) });
const sse = (res, ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
const bcast = (r, ev, d, except) => r.clients.forEach(c => c.cid !== except && sse(c.res, ev, d));
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const roster = r => [...new Map([...r.clients].map(c => [c.cid, { cid: c.cid, name: c.name, host: c.host }])).values()];
const sendRoster = (r, except) => bcast(r, 'roster', roster(r), except);
const sendLudo = r => bcast(r, 'ludo', ludo.view(r.ludo));
const drop = r => { if (r.file) fs.rm(r.file, () => {}); r.file = null; };

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname, q = new URL(req.url, 'http://x').searchParams;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'GET' && (p === '/' || p.startsWith('/r/'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(HTML);
  }
  if (req.method === 'POST' && p === '/api/rooms') {
    if (rooms.size >= 200) return json(res, 503, { error: 'Server is busy, try again later.' });
    const id = crypto.randomBytes(12).toString('base64url'), key = crypto.randomBytes(16).toString('base64url');
    rooms.set(id, { key, file: null, ver: 0, name: '', type: '', size: 0, clients: new Set(), banned: new Set(), ludo: ludo.fresh(), chat: [], state: { playing: false, time: 0, at: Date.now() }, touched: Date.now() });
    return json(res, 200, { id, key });
  }
  if (req.method === 'GET' && p === '/api/ice') {           // STUN by default, TURN if configured
    const ice = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
    return json(res, 200, ice);
  }
  const m = p.match(/^\/api\/rooms\/([\w-]{16})\/(video|events|action|chat|signal|join|kick|ludo|end)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const r = rooms.get(m[1]);
  if (!r) return json(res, 404, { error: 'Room not found or expired.' });
  r.touched = Date.now();

  if (m[2] === 'events' && req.method === 'GET') {
    const cid = String(q.get('cid') || '').slice(0, 32);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (r.banned.has(cid)) { sse(res, 'kicked', {}); return res.end(); }
    const c = { res, cid, name: '', host: false, tok: crypto.randomBytes(8).toString('hex') };
    r.clients.add(c);
    sse(res, 'hello', { video: r.file ? { name: r.name, ver: r.ver } : null, state: snap(r), roster: roster(r), chat: r.chat, ludo: ludo.view(r.ludo), tok: c.tok });
    sendRoster(r, c.cid);
    if (ludo.setAway(r.ludo, cid, false)) sendLudo(r);
    req.on('close', () => {
      r.clients.delete(c); sendRoster(r);
      if (![...r.clients].some(x => x.cid === c.cid) && ludo.setAway(r.ludo, c.cid, true)) sendLudo(r);
    });
    return;
  }

  if (m[2] === 'join' && req.method === 'POST') {            // announce my display name (and prove I'm the host, if I am)
    let body = '';
    req.on('data', d => { body += d; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), cid = String(a.cid || '').slice(0, 32);
        if (!cid) throw 0;
        if (r.banned.has(cid)) return json(res, 403, { error: 'Removed by the host.' });
        const name = String(a.name || '').trim().slice(0, 24) || 'Guest', host = req.headers['x-host-key'] === r.key;
        for (const c of r.clients) if (c.cid === cid) { c.name = name; if (host) c.host = true; }
        sendRoster(r);
        if (ludo.rename(r.ludo, cid, name)) sendLudo(r);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
    return;
  }

  if (m[2] === 'kick' && req.method === 'POST') {            // host removes someone
    if (req.headers['x-host-key'] !== r.key) return json(res, 403, { error: 'Only the room creator can remove people.' });
    let body = '';
    req.on('data', d => { body += d; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      try {
        const target = String(JSON.parse(body).target || '').slice(0, 32);
        if (!target) throw 0;
        const hit = [...r.clients].filter(c => c.cid === target);
        if (hit.some(c => c.host)) return json(res, 400, { error: 'You cannot remove the host.' });
        if (r.banned.size < 200) r.banned.add(target);
        for (const c of hit) { sse(c.res, 'kicked', {}); c.res.end(); r.clients.delete(c); }
        bcast(r, 'removed', { cid: target });
        if (ludo.out(r.ludo, target)) sendLudo(r);
        sendRoster(r);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
    return;
  }

  if (m[2] === 'ludo' && req.method === 'POST') {            // all game actions; dice are rolled here on the server
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), cid = String(a.cid || '').slice(0, 32);
        const me = [...r.clients].find(c => c.cid === cid && c.tok === String(a.tok || ''));
        if (!cid || !me || r.banned.has(cid)) return json(res, 403, { error: 'Reconnect to the room and try again.' });
        const err = ludo.act(r.ludo, { cid, name: me.name || 'Guest' }, a, req.headers['x-host-key'] === r.key || me.host);
        if (err) return json(res, 400, { error: err });
        sendLudo(r);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
    return;
  }

  if (m[2] === 'end' && req.method === 'POST') {             // host ends the room for everyone
    if (req.headers['x-host-key'] !== r.key) return json(res, 403, { error: 'Only the room creator can end the room.' });
    bcast(r, 'ended', {});
    for (const c of r.clients) c.res.end();
    r.clients.clear(); drop(r); rooms.delete(m[1]);
    return json(res, 200, { ok: true });
  }

  if (m[2] === 'signal' && req.method === 'POST') {          // relays WebRTC call setup between people in the room
    let body = '';
    req.on('data', d => { body += d; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), from = String(a.cid || '').slice(0, 32), to = String(a.to || '');
        if (!from || typeof a.data !== 'object' || !a.data) throw 0;
        if (r.banned.has(from)) return json(res, 403, { error: 'Removed by the host.' });
        for (const c of r.clients) if (c.cid !== from && (!to || c.cid === to)) sse(c.res, 'signal', { from, data: a.data });
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
    return;
  }

  if (m[2] === 'chat' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), text = String(a.text || '').trim().slice(0, 400);
        if (!text) throw 0;
        if (r.banned.has(String(a.cid || '').slice(0, 32))) return json(res, 403, { error: 'Removed by the host.' });
        const msg = { name: String(a.name || 'Guest').trim().slice(0, 24) || 'Guest', text, cid: String(a.cid || '').slice(0, 32), t: Date.now() };
        r.chat.push(msg); if (r.chat.length > 50) r.chat.shift();
        bcast(r, 'chat', msg);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
    return;
  }

  if (m[2] === 'action' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const a = JSON.parse(body), t = Number(a.time);
        if (!Number.isFinite(t)) throw 0;
        if (r.banned.has(String(a.cid || '').slice(0, 32))) return json(res, 403, { error: 'Removed by the host.' });
        r.state = { playing: !!a.playing, time: Math.max(0, t), at: Date.now() };
        bcast(r, 'state', snap(r), String(a.cid || ''));
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
    return;
  }

  if (m[2] === 'video' && req.method === 'PUT') {          // host uploads
    if (req.headers['x-host-key'] !== r.key) return json(res, 403, { error: 'Only the room creator can upload.' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BYTES) return json(res, 413, { error: `File too large (max ${MAX_BYTES / 1048576} MB).` });
    const type = String(req.headers['content-type'] || '');
    if (!/^video\//.test(type)) return json(res, 415, { error: 'Please choose a video file.' });
    drop(r);
    const file = path.join(UP, crypto.randomBytes(8).toString('hex'));
    const out = fs.createWriteStream(file); let n = 0, dead = false;
    const fail = (code, msg) => { if (dead) return; dead = true; out.destroy(); fs.rm(file, () => {}); if (!res.headersSent) json(res, code, { error: msg }); };
    req.on('data', c => { n += c.length; if (n > MAX_BYTES) { fail(413, 'File too large.'); req.destroy(); } });
    req.on('aborted', () => fail(400, 'Upload cancelled.'));
    out.on('error', () => fail(500, 'Could not save the video.'));
    out.on('finish', () => {
      if (dead) return;
      Object.assign(r, { file, type, size: n, ver: r.ver + 1, name: decodeURIComponent(String(req.headers['x-file-name'] || 'Video')).slice(0, 120) });
      r.state = { playing: false, time: 0, at: Date.now() };
      bcast(r, 'video', { name: r.name, ver: r.ver });
      json(res, 200, { ok: true });
    });
    return req.pipe(out);
  }

  if (m[2] === 'video' && req.method === 'GET') {          // everyone streams with Range support
    if (r.banned.has(String(q.get('cid') || '').slice(0, 32))) return json(res, 403, { error: 'Removed by the host.' });
    if (!r.file) return json(res, 404, { error: 'No video yet.' });
    const size = r.size, h = { 'Content-Type': r.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
    let start = 0, end = size - 1, code = 200;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg) {
      if (rg[1] === '') { start = Math.max(0, size - Number(rg[2])); }
      else { start = Number(rg[1]); if (rg[2]) end = Math.min(Number(rg[2]), size - 1); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      code = 206; h['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    h['Content-Length'] = end - start + 1;
    res.writeHead(code, h);
    const s = fs.createReadStream(r.file, { start, end });
    s.on('error', () => res.destroy()); res.on('close', () => s.destroy());
    return s.pipe(res);
  }
  res.writeHead(405); res.end();
}).listen(PORT, () => {
  console.log(`Fun time is running.\n  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Same Wi-Fi:     http://${i.address}:${PORT}`);
});

setInterval(() => {                                        // drift-correction ticks + keep-alive + cleanup
  const t = Date.now();
  for (const [id, r] of rooms) {
    if (r.clients.size) { r.touched = t; bcast(r, 'tick', snap(r)); }
    else if (t - r.touched > TTL) { drop(r); rooms.delete(id); }
  }
}, 3000);
