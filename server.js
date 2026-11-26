'use strict';
/*
  Chakib Zenji 2 : serveur unique pour Railway.
  1) Il sert le jeu (dossier public/).
  2) Il tient le relais des salons en ligne : les joueurs se connectent en WebSocket, ce serveur fait suivre les
     messages entre l'hôte d'un salon et ses invités. La partie, elle, tourne dans le navigateur de l'hôte.
  Protocole : celui du client du jeu (src/09d-netrelay.js).
     /room/CODE?role=host|guest&id=ID&key=CLE
     trames de contrôle : STX + commande + SOH + a + SOH + b
     hôte -> serveur : "id1,id2" SOH json | STX pub | STX kick | STX ban
     serveur -> hôte : STX sync | STX join | STX leave | STX refuse | "id" SOH json
     serveur -> invité : STX host SOH 1|0 | STX refuse | json
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');
const CTL = '\x02', SEP = '\x01';
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 2000;
const MAX_GUESTS = Number(process.env.MAX_GUESTS_PER_ROOM) || 16;
const MAX_PAYLOAD = 128 * 1024;
const MAX_BUFFER = 1024 * 1024;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 100;
const HOST_GRACE_MS = 60 * 1000; // une hôte coupé garde son salon ce temps-là (le jeu retente tout de suite)
const TAKE_OVER_MS = 20 * 1000; // pendant ce temps, seul l'hôte d'origine (même clé) peut reprendre le code
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/* ---------- Codes de fermeture compris par le jeu ---------- */
const NOT_FOUND = 4004, FULL = 4002, KICKED = 4003, TAKEN = 4011, BUSY = 4013, TOO_MANY = 4029, BAD = 4001;

/* ---------- Fichiers du jeu ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.json', '.txt', '.webmanifest', '.svg']);
const HASHED = /\.[0-9a-f]{8}\.[a-z0-9]+$/i; // fichiers dont le nom change avec le contenu : cache d'un an
const NO_CACHE = new Set(['/index.html', '/sw.js', '/version.json', '/manifest.webmanifest']);

const gzCache = new Map(); // chemin -> { mtime, buf }
function gzipOf(file, st) {
  const hit = gzCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.buf;
  const buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
  gzCache.set(file, { mtime: st.mtimeMs, buf });
  return buf;
}

/* La page est construite avec l'adresse « wss://__RELAY_HOST__ » : le serveur y met le domaine réellement utilisé */
const pageCache = new Map(); // "schéma|hôte" -> { buf, gz, etag }
function publicHost(req) {
  const h = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return /^[a-z0-9.-]+(:\d{1,5})?$/.test(h) ? h : '';
}
function isSecure(req) { return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function renderPage(host, secure) {
  const key = (secure ? 's|' : 'p|') + host;
  let p = pageCache.get(key);
  if (p) return p;
  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = raw.split('wss://__RELAY_HOST__').join((secure ? 'wss://' : 'ws://') + host)
    .split('https://__RELAY_HOST__').join((secure ? 'https://' : 'http://') + host);
  const buf = Buffer.from(html, 'utf8');
  p = { buf, gz: zlib.gzipSync(buf, { level: 6 }), etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"' };
  if (pageCache.size >= 6) pageCache.delete(pageCache.keys().next().value);
  pageCache.set(key, p);
  return p;
}

function baseHeaders(extra) {
  return Object.assign({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' }, extra);
}
function send(res, code, body, headers) {
  res.writeHead(code, baseHeaders(headers));
  res.end(body);
}
function acceptsGzip(req) { return /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')); }

function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' }); }
  if (pathname.includes('\0') || pathname.includes('\\')) return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain' });

  if (pathname === '/health') {
    const body = JSON.stringify({ ok: true, rooms: rooms.size, players: playerCount() });
    return send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  }
  if (pathname === '/' || pathname === '/index.html') {
    const host = publicHost(req);
    if (!host) return send(res, 400, 'Bad host', { 'Content-Type': 'text/plain' });
    const p = renderPage(host, isSecure(req));
    const h = { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ETag: p.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === p.etag) return send(res, 304, undefined, h);
    const gz = acceptsGzip(req);
    if (gz) h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = (gz ? p.gz : p.buf).length;
    res.writeHead(200, baseHeaders(h));
    return res.end(req.method === 'HEAD' ? undefined : (gz ? p.gz : p.buf));
  }

  const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const file = path.join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file).toLowerCase();
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: 'W/"' + st.size + '-' + Math.floor(st.mtimeMs) + '"', 'Last-Modified': st.mtime.toUTCString() };
    h['Cache-Control'] = NO_CACHE.has('/' + rel.split(path.sep).join('/')) ? 'no-cache' : HASHED.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    if (req.headers['if-none-match'] === h.ETag) return send(res, 304, undefined, h);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] !== '' || range[2] !== '')) { // lecture partielle (Safari en a besoin pour la musique)
      let a = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
      let b = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
      if (a > b || a >= st.size) { h['Content-Range'] = 'bytes */' + st.size; return send(res, 416, undefined, h); }
      h['Content-Range'] = 'bytes ' + a + '-' + b + '/' + st.size; h['Content-Length'] = b - a + 1;
      res.writeHead(206, baseHeaders(h));
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start: a, end: b }).on('error', () => res.destroy()).pipe(res);
    }
    if (COMPRESSIBLE.has(ext) && st.size > 1024 && acceptsGzip(req)) {
      let gz; try { gz = gzipOf(file, st); } catch (e) { return send(res, 500, 'Server error', { 'Content-Type': 'text/plain' }); }
      h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; h['Content-Length'] = gz.length;
      res.writeHead(200, baseHeaders(h));
      return res.end(req.method === 'HEAD' ? undefined : gz);
    }
    h['Content-Length'] = st.size;
    res.writeHead(200, baseHeaders(h));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

/* ---------- Salons ---------- */
const rooms = new Map(); // code -> { code, host, hostKey, guests: Map(id -> { ws, key, ip }), gone, timer, bans: { keys, ips }, meta }
function playerCount() { let n = 0; for (const r of rooms.values()) n += r.guests.size + (r.host ? 1 : 0); return n; }
function open(ws) { return ws && ws.readyState === 1; }
function tx(ws, text) { if (open(ws) && ws.bufferedAmount < MAX_BUFFER) { try { ws.send(text); } catch (e) { /* fermeture en cours */ } } }
function ctl(ws, cmd, a, b) { tx(ws, CTL + cmd + (a !== undefined ? SEP + a : '') + (b !== undefined ? SEP + b : '')); }
function refuse(ws, code, why) { ctl(ws, 'refuse', String(code), why || ''); try { ws.close(code, why ? String(why).slice(0, 100) : ''); } catch (e) { /* déjà fermée */ } }
function dropRoom(room) { clearTimeout(room.timer); if (rooms.get(room.code) === room) rooms.delete(room.code); }
function closeGuests(room, code) { for (const g of [...room.guests.values()]) { try { g.ws.close(code); } catch (e) { /* déjà fermée */ } } room.guests.clear(); }

function connectHost(ws, code, id, key, ip) {
  let room = rooms.get(code);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return refuse(ws, BUSY, 'saturé');
    room = { code, host: null, hostKey: '', guests: new Map(), gone: 0, timer: 0, bans: { keys: new Set(), ips: new Set() }, meta: '' };
    rooms.set(code, room);
  } else if (open(room.host)) {
    if (room.hostKey !== key) return refuse(ws, TAKEN, 'code déjà pris'); // un autre salon porte déjà ce code
    try { room.host.close(4010, 'remplacé'); } catch (e) { /* déjà fermée */ } // même hôte qui se reconnecte avant que l'ancienne liaison soit notée perdue
  } else if (room.hostKey && room.hostKey !== key) {
    if (room.guests.size && Date.now() - room.gone < TAKE_OVER_MS) return refuse(ws, TAKEN, 'code déjà pris');
    closeGuests(room, NOT_FOUND); room.bans = { keys: new Set(), ips: new Set() }; // un autre salon reprend ce code : les anciens invités s'en vont
  }
  clearTimeout(room.timer);
  room.host = ws; room.hostKey = key; room.gone = 0;
  ws.room = room; ws.role = 'host'; ws.id = id;
  ctl(ws, 'sync', [...room.guests.keys()].join(','));
  for (const g of room.guests.values()) ctl(g.ws, 'host', '1');
}

function connectGuest(ws, code, id, key, ip) {
  const room = rooms.get(code);
  if (!room || !open(room.host)) return refuse(ws, NOT_FOUND, 'salon introuvable');
  if (room.bans.keys.has(key) || room.bans.ips.has(ip)) return refuse(ws, KICKED, 'exclu');
  const old = room.guests.get(id);
  if (old) {
    if (old.key !== key) return refuse(ws, BAD, 'identifiant pris');
    try { old.ws.close(4010, 'remplacé'); } catch (e) { /* déjà fermée */ }
  } else if (room.guests.size >= MAX_GUESTS) return refuse(ws, FULL, 'salon complet');
  room.guests.set(id, { ws, key, ip });
  ws.room = room; ws.role = 'guest'; ws.id = id;
  ctl(ws, 'host', '1');
  ctl(room.host, 'join', id);
}

function onHostMessage(ws, text) {
  const room = ws.room; if (!room || room.host !== ws) return;
  if (text.charCodeAt(0) === 2) { // commandes de l'hôte
    const [cmd, a] = text.slice(1).split(SEP);
    if (cmd === 'pub') room.meta = String(a || '').slice(0, 2048);
    else if (cmd === 'kick' || cmd === 'ban') {
      const g = room.guests.get(a);
      if (!g) return;
      if (cmd === 'ban') { room.bans.keys.add(g.key); if (g.ip) room.bans.ips.add(g.ip); }
      room.guests.delete(a);
      refuse(g.ws, KICKED, 'exclu');
    }
    return;
  }
  const cut = text.indexOf(SEP);
  if (cut < 1) return;
  const payload = text.slice(cut + 1);
  const ids = text.slice(0, cut).split(',', MAX_GUESTS + 1);
  for (const id of ids) { const g = room.guests.get(id); if (g) tx(g.ws, payload); }
}
function onGuestMessage(ws, text) {
  const room = ws.room; if (!room || !room.guests.has(ws.id) || room.guests.get(ws.id).ws !== ws) return;
  if (open(room.host)) tx(room.host, ws.id + SEP + text);
}

function onClose(ws) {
  ipCount(ws.ip, -1);
  const room = ws.room; if (!room) return;
  if (ws.role === 'guest') {
    const g = room.guests.get(ws.id);
    if (g && g.ws === ws) { room.guests.delete(ws.id); if (open(room.host)) ctl(room.host, 'leave', ws.id); }
    if (!room.guests.size && !room.host) dropRoom(room);
  } else if (ws.role === 'host' && room.host === ws) {
    room.host = null; room.gone = Date.now();
    for (const g of room.guests.values()) ctl(g.ws, 'host', '0');
    if (!room.guests.size) { dropRoom(room); return; }
    clearTimeout(room.timer);
    room.timer = setTimeout(() => { if (!room.host) { closeGuests(room, NOT_FOUND); dropRoom(room); } }, HOST_GRACE_MS);
  }
}

/* ---------- Limites par adresse ---------- */
const perIp = new Map(), recent = new Map();
function ipCount(ip, d) { if (!ip) return; const n = (perIp.get(ip) || 0) + d; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); }
function rateOk(ip) { // 60 nouvelles connexions par 10 s au plus, par adresse
  const now = Date.now(); let r = recent.get(ip);
  if (!r || now - r.t > 10000) { r = { t: now, n: 0 }; recent.set(ip, r); }
  return ++r.n <= 60;
}
setInterval(() => { const now = Date.now(); for (const [ip, r] of recent) if (now - r.t > 10000) recent.delete(ip); }, 30000).unref();
function clientIp(req) { // Railway pose X-Real-IP (l'adresse réelle du joueur, jamais celle envoyée par le client)
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').trim();
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // pas un navigateur
  let u; try { u = new URL(o); } catch (e) { return false; }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return u.host.toLowerCase() === host || ALLOWED.includes('*') || ALLOWED.includes(u.origin.toLowerCase());
}

/* ---------- Serveur ---------- */
const server = http.createServer((req, res) => { try { serve(req, res); } catch (e) { console.error(e); try { send(res, 500, 'Server error', { 'Content-Type': 'text/plain' }); } catch (e2) { /* ignoré */ } } });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const fail = (line) => { try { socket.write('HTTP/1.1 ' + line + '\r\nConnection: close\r\n\r\n'); } catch (e) { /* ignoré */ } socket.destroy(); };
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return fail('400 Bad Request'); }
  const m = /^\/room\/([A-Za-z0-9]{3,16})$/.exec(u.pathname);
  if (!m) return fail('404 Not Found');
  if (!originOk(req)) return fail('403 Forbidden');
  const role = u.searchParams.get('role'), id = u.searchParams.get('id') || '', key = u.searchParams.get('key') || '';
  if ((role !== 'host' && role !== 'guest') || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[A-Za-z0-9]{8,64}$/.test(key)) return fail('400 Bad Request');
  const ip = clientIp(req);
  if (!rateOk(ip) || (perIp.get(ip) || 0) >= MAX_CONN_PER_IP) return fail('429 Too Many Requests');
  const code = m[1].toUpperCase();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.ip = ip; ws.alive = true; ws.room = null; ws.role = ''; ws.id = '';
    ipCount(ip, 1);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (ws.role === 'host') onHostMessage(ws, text); else if (ws.role === 'guest') onGuestMessage(ws, text);
    });
    ws.on('close', () => onClose(ws));
    ws.on('error', () => { /* close suit toujours */ });
    if (role === 'host') connectHost(ws, code, id, key, ip); else connectGuest(ws, code, id, key, ip);
  });
});

/* Liaisons mortes (réseau coupé sans fermeture) : un ping toutes les 25 s, coupée au 2e oubli */
const beat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) { /* ignoré */ } }
}, 25000);
beat.unref();

server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignoré */ } });
server.listen(PORT, '0.0.0.0', () => console.log('Chakib Zenji 2 : serveur prêt sur le port ' + PORT + ' (' + new Date().toISOString() + ')'));
setInterval(() => { if (rooms.size) console.log('salons : ' + rooms.size + ', joueurs : ' + playerCount()); }, 10 * 60 * 1000).unref();

function stop() {
  console.log('arrêt demandé');
  for (const ws of wss.clients) { try { ws.close(1001); } catch (e) { /* ignoré */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
