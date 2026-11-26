'use strict';
// Lance le serveur sur un port libre puis vérifie le site et le relais des salons. Utilisation : npm test
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = 'http://127.0.0.1:' + PORT;
const CTL = '\x02', SEP = '\x01';
let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p, headers, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method: method || 'GET', headers: headers || {} }, (res) => {
      const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
function client(code, role, id, key, headers) {
  const c = { msgs: [], closed: null, status: 0 };
  c.ws = new WebSocket('ws://127.0.0.1:' + PORT + '/room/' + code + '?role=' + role + '&id=' + id + '&key=' + key, { headers: headers || {} });
  c.ws.on('message', (d, bin) => { if (!bin) c.msgs.push(d.toString()); });
  let settle, closeRes; c.opened = new Promise((r) => { settle = r; });
  const closedP = new Promise((r) => { closeRes = r; });
  c.ws.on('open', () => settle());
  c.ws.on('close', (code2) => { c.closed = code2; settle(); closeRes(); });
  c.ws.on('unexpected-response', (req, res) => { c.status = res.statusCode; res.resume(); req.destroy(); settle(); closeRes(); });
  c.ws.on('error', () => {});
  c.end = (ms) => Promise.race([closedP, sleep(ms || 1200)]);
  c.has = (s) => c.msgs.some((m) => m === s);
  c.wait = async (pred, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 1500)) { if (c.msgs.some(pred)) return true; await sleep(15); } return false; };
  return c;
}
const K = (n) => 'key' + String(n).padStart(8, '0') + 'abcdef';

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), MAX_GUESTS_PER_ROOM: '3' }), stdio: 'inherit' });
  for (let i = 0; i < 100; i++) { try { await get('/health'); break; } catch (e) { await sleep(100); } }
  try {
    console.log('Site');
    let r = await get('/health'); ok(r.status === 200 && JSON.parse(r.body).ok === true, '/health repond ok');
    r = await get('/', { host: 'jeu.example.com', 'x-forwarded-proto': 'https' });
    let html = r.body.toString();
    ok(r.status === 200 && /text\/html/.test(r.headers['content-type']), 'la page s\'ouvre');
    ok(!html.includes('__RELAY_HOST__'), 'plus aucun marqueur dans la page');
    ok(html.includes('content="wss://jeu.example.com"') && html.includes('connect-src \'self\' https://jeu.example.com wss://jeu.example.com'), 'adresse du relais et regle de securite = le domaine demande');
    ok(html.includes('name="cod-relay-mode" content="hybrid"'), 'mode hybride annonce');
    r = await get('/', { host: '127.0.0.1:' + PORT }); html = r.body.toString();
    ok(html.includes('content="ws://127.0.0.1:' + PORT + '"'), 'en local (http) : ws:// et non wss://');
    r = await get('/', { host: 'jeu.example.com', 'x-forwarded-proto': 'https', 'accept-encoding': 'gzip' });
    ok(r.headers['content-encoding'] === 'gzip' && require('zlib').gunzipSync(r.body).toString().length > 1000000, 'la page est compressee (gzip)');
    const et = r.headers.etag; r = await get('/', { host: 'jeu.example.com', 'x-forwarded-proto': 'https', 'if-none-match': et }); ok(r.status === 304, 'ETag : 304 si inchange');
    r = await get('/', { host: 'bad host!' }); ok(r.status === 400, 'hote invalide refuse');
    r = await get('/credits.html'); ok(r.status === 200, 'credits.html');
    r = await get('/LICENSE.txt'); ok(r.status === 200, 'LICENSE.txt');
    r = await get('/manifest.webmanifest'); ok(r.status === 200 && /manifest/.test(r.headers['content-type']) && r.headers['cache-control'] === 'no-cache', 'manifest : bon type, pas de cache');
    r = await get('/sw.js'); ok(r.status === 200 && r.headers['cache-control'] === 'no-cache', 'sw.js : pas de cache');
    const fs = require('fs'); const tex = fs.readdirSync(path.join(__dirname, '..', 'public', 'tex')).find((f) => /\.[0-9a-f]{8}\./.test(f));
    r = await get('/tex/' + tex); ok(r.status === 200 && /immutable/.test(r.headers['cache-control']), 'fichier a empreinte : cache d\'un an');
    r = await get('/menu-theme.mp3', { range: 'bytes=10-19' }); ok(r.status === 206 && r.body.length === 10 && /^bytes 10-19\//.test(r.headers['content-range']), 'lecture partielle (musique) : 206');
    r = await get('/menu-theme.mp3', { range: 'bytes=99999999-' }); ok(r.status === 416, 'plage hors fichier : 416');
    r = await get('/nope.js'); ok(r.status === 404, 'fichier absent : 404');
    r = await get('/../server.js'); ok(r.status === 404, 'sortie du dossier impossible (..)');
    r = await get('/%2e%2e/server.js'); ok(r.status === 404, 'sortie du dossier impossible (%2e%2e)');
    r = await get('/.env'); ok(r.status === 404, 'fichiers caches refuses');
    r = await get('/', {}, 'POST'); ok(r.status === 405, 'POST refuse');
    r = await get('/', { host: '127.0.0.1:' + PORT }, 'HEAD'); ok(r.status === 200 && r.body.length === 0, 'HEAD sans corps');

    console.log('Relais');
    let g = client('ZZZZZ', 'guest', 'g1', K(1)); await g.end();
    ok(g.closed === 4004 && g.msgs.some((m) => m.startsWith(CTL + 'refuse' + SEP + '4004')), 'invite sans salon : refus 4004 (introuvable)');

    const h = client('AB123', 'host', 'ID-AB123', K(100)); await h.opened;
    ok(await h.wait((m) => m === CTL + 'sync' + SEP), 'hote : sync vide a la connexion');
    const g1 = client('AB123', 'guest', 'g1', K(1)); await g1.opened;
    ok(await g1.wait((m) => m === CTL + 'host' + SEP + '1'), 'invite : annonce "hote present"');
    ok(await h.wait((m) => m === CTL + 'join' + SEP + 'g1'), 'hote : prevenu de l\'arrivee de g1');
    g1.ws.send(JSON.stringify({ t: 'hi', n: 'Chakib' }));
    ok(await h.wait((m) => m === 'g1' + SEP + '{"t":"hi","n":"Chakib"}'), 'invite -> hote : message recu avec l\'identifiant');
    h.ws.send('g1' + SEP + JSON.stringify({ t: 'cfg', map: 1 }));
    ok(await g1.wait((m) => m === '{"t":"cfg","map":1}'), 'hote -> invite : message recu');
    const g2 = client('ab123', 'guest', 'g2', K(2)); await g2.opened; // minuscules : meme salon
    ok(await h.wait((m) => m === CTL + 'join' + SEP + 'g2'), 'le code n\'est pas sensible a la casse');
    h.ws.send('g1,g2,gX' + SEP + '{"t":"all"}'); await sleep(150);
    ok(g1.has('{"t":"all"}') && g2.has('{"t":"all"}'), 'hote -> plusieurs invites en un envoi');
    ok(g1.msgs.filter((m) => m === '{"t":"all"}').length === 1, 'chaque invite ne recoit le message qu\'une fois');

    const h2 = client('AB123', 'host', 'ID-X', K(101)); await h2.end();
    ok(h2.closed === 4011 && h2.msgs.some((m) => m.startsWith(CTL + 'refuse' + SEP + '4011')), 'autre hote, meme code : refus 4011 (pris)');

    g2.ws.close(); ok(await h.wait((m) => m === CTL + 'leave' + SEP + 'g2'), 'hote : prevenu du depart de g2');

    // reconnexion de l'hote avec la meme cle
    const h3 = client('AB123', 'host', 'ID-AB123', K(100)); await h3.opened;
    ok(await h3.wait((m) => m === CTL + 'sync' + SEP + 'g1'), 'hote reconnecte : sync liste les invites presents');
    await sleep(100); ok(h.closed === 4010, 'ancienne liaison de l\'hote fermee (4010)');
    ok(g1.msgs.filter((m) => m === CTL + 'host' + SEP + '1').length >= 2, 'invites : "hote present" renvoye apres la reconnexion');

    // coupure puis retour de l'hote
    h3.ws.close(); ok(await g1.wait((m) => m === CTL + 'host' + SEP + '0'), 'hote coupe : invites prevenus (host 0)');
    const g3 = client('AB123', 'guest', 'g3', K(3)); await g3.end(); ok(g3.closed === 4004, 'salon sans hote : nouvel invite refuse (4004)');
    const h4 = client('AB123', 'host', 'ID-AB123', K(100)); await h4.opened;
    ok(await h4.wait((m) => m === CTL + 'sync' + SEP + 'g1'), 'hote de retour dans les temps : salon intact');
    // un autre hote ne peut pas voler le code pendant la coupure
    h4.ws.close(); await sleep(150);
    const h5 = client('AB123', 'host', 'ID-Y', K(102)); await h5.end(); ok(h5.closed === 4011, 'pendant la coupure, un autre hote ne prend pas le code');
    const h6 = client('AB123', 'host', 'ID-AB123', K(100)); await h6.opened; await sleep(100);

    // exclusion et bannissement
    const g4 = client('AB123', 'guest', 'g4', K(4)); await g4.opened; await sleep(80);
    h6.ws.send(CTL + 'kick' + SEP + 'g4'); await sleep(150);
    ok(g4.closed === 4003, 'exclusion : invite ferme avec 4003');
    const g4b = client('AB123', 'guest', 'g4', K(4)); await g4b.opened; await sleep(80); ok(g4b.closed === null, 'apres une simple exclusion, il peut revenir');
    h6.ws.send(CTL + 'ban' + SEP + 'g4'); await sleep(150); ok(g4b.closed === 4003, 'bannissement : invite ferme avec 4003');
    const g4c = client('AB123', 'guest', 'g9', K(9)); await g4c.end(); ok(g4c.closed === 4003, 'banni (meme adresse) : refuse meme avec une autre cle');

    // salon complet (3 invites au plus dans ce test) : g1 est la ; on libere la ban en changeant de salon
    const hf = client('FULL1', 'host', 'ID-F', K(110)); await hf.opened;
    const f = []; for (let i = 0; i < 3; i++) { f.push(client('FULL1', 'guest', 'f' + i, K(120 + i))); await f[i].opened; }
    await sleep(80); const f4 = client('FULL1', 'guest', 'f9', K(129)); await f4.end(); ok(f4.closed === 4002, 'salon complet : refus 4002');
    const fdup = client('FULL1', 'guest', 'f0', K(555)); await fdup.end(); ok(fdup.closed === 4001, 'identifiant deja pris avec une autre cle : refuse');
    const fsame = client('FULL1', 'guest', 'f0', K(120)); await fsame.opened; await sleep(100); ok(f[0].closed === 4010 && fsame.closed === null, 'meme invite qui revient : remplace l\'ancienne liaison');

    console.log('Requetes invalides');
    let bad = client('AB123', 'guest', 'bad id!', K(7)); await bad.opened; ok(bad.status === 400, 'identifiant invalide : 400');
    bad = client('AB123', 'guest', 'ok1', 'short'); await bad.opened; ok(bad.status === 400, 'cle trop courte : 400');
    bad = client('AB123', 'nobody', 'ok1', K(7)); await bad.opened; ok(bad.status === 400, 'role inconnu : 400');
    const raw = new WebSocket('ws://127.0.0.1:' + PORT + '/autre'); let rs = 0; raw.on('unexpected-response', (q, s) => { rs = s.statusCode; s.resume(); }); raw.on('error', () => {}); await sleep(300); ok(rs === 404, 'chemin inconnu : 404');
    bad = client('AB123', 'guest', 'ok2', K(8), { Origin: 'http://evil.example' }); await bad.opened; ok(bad.status === 403, 'origine etrangere : 403');
    bad = client('QQ999', 'host', 'ok3', K(9), { Origin: 'http://127.0.0.1:' + PORT }); await bad.opened; await sleep(80); ok(bad.closed === null && bad.status === 0, 'meme origine : accepte'); bad.ws.close();
    // binaire ignore, trop gros ferme
    g1.ws.send(Buffer.from([1, 2, 3]), { binary: true }); await sleep(100); ok(g1.closed === null, 'trame binaire ignoree');
    g1.ws.send('x'.repeat(200 * 1024)); await sleep(250); ok(g1.closed === 1009, 'message trop gros : connexion fermee (1009)');
    r = await get('/health'); const hb = JSON.parse(r.body); ok(hb.ok && hb.rooms >= 1 && hb.players >= 1, '/health compte les salons', JSON.stringify(hb));
  } finally {
    srv.kill('SIGTERM'); await sleep(300);
  }
  console.log('\n' + pass + ' reussis, ' + fail + ' echecs');
  process.exit(fail ? 1 : 0);
}
setTimeout(() => { console.log('DELAI DEPASSE'); process.exit(2); }, 100000).unref();
main().catch((e) => { console.error(e); process.exit(1); });
