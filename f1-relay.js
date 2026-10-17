#!/usr/bin/env node
/*
  f1-relay.js : connects to Formula 1's own live timing feed and serves it to f1-race-watch.html
  on your computer. No account, no key, no cost.

  First time only (in the folder that contains this file):
      npm install ws
  Then every race (or just double-click "Start Race Watch.bat" on Windows):
      node f1-relay.js --open
  Leave the window open. --open opens the app in your browser at http://localhost:3000
  (this relay serves f1-race-watch.html when it sits in the same folder as this file).
  The Relay button inside the app shows this relay's status and live log.
*/
'use strict';

let WebSocket;
try { WebSocket = require('ws'); } catch {
  console.error('\nThe "ws" package is missing. Run this once in this folder:\n\n    npm install ws\n\nthen start again with:  node f1-relay.js\n');
  process.exit(1);
}
const http = require('http'), https = require('https'), zlib = require('zlib'), fs = require('fs'), nodePath = require('path'), { URL } = require('url'), { exec } = require('child_process');
const VERSION = '2.0';
const OPEN = process.argv.includes('--open');
const STARTED = Date.now();

const PORT = +process.env.PORT || 3000;
const F1_HTTP = process.env.F1_HTTP || 'https://livetiming.formula1.com';
const F1_WS = process.env.F1_WS || 'wss://livetiming.formula1.com';
const UA = 'BestHTTP';
const RS = '\x1e';                                   // SignalR record separator
// Everything the app needs. (Car telemetry and GPS are left out: F1 only gives them to F1 TV subscribers.)
const TOPICS = ['Heartbeat', 'DriverList', 'ExtrapolatedClock', 'RaceControlMessages', 'SessionInfo', 'SessionStatus', 'TeamRadio',
  'TimingAppData', 'TimingStats', 'TrackStatus', 'WeatherData', 'SessionData', 'TimingData', 'TopThree', 'LapCount'];

const state = {};                                    // merged feed state, keyed by topic
const meta = {connected: false, since: null, lastMsg: 0, msgCount: 0, error: '', attempts: 0};
const LOG = [], LOG_MAX = 300; let logSeq = 0;
const log = (...a) => {
  const msg = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  console.log(new Date().toLocaleTimeString(), msg);
  LOG.push({n: ++logSeq, t: Date.now(), msg}); if (LOG.length > LOG_MAX) LOG.shift();
};
let currentWs = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listOf = x => (!x ? [] : Array.isArray(x) ? x : Object.values(x)).filter(v => v != null);

/* ---------- F1 connection (SignalR Core over WebSocket) ---------- */
function request(method, urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr), lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {method, headers: {'User-Agent': UA, 'Accept-Encoding': 'gzip, identity', ...headers}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try { if (/gzip/.test(res.headers['content-encoding'] || '')) buf = zlib.gunzipSync(buf); } catch {}
        resolve({status: res.statusCode, headers: res.headers, body: buf.toString('utf8')});
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

function merge(t, p) {                               // F1 sends small patches; fold them into the running state
  if (Array.isArray(p)) return p;
  if (p === null || typeof p !== 'object') return p;
  if (Array.isArray(t)) {
    const out = t.slice();
    for (const k of Object.keys(p)) { if (k === '_deleted') continue; const i = +k; if (!isNaN(i)) out[i] = merge(out[i], p[k]); }
    return out;
  }
  const out = t && typeof t === 'object' ? t : {};
  for (const k of Object.keys(p)) {
    if (k === '_deleted') { listOf(p[k]).forEach(d => delete out[d]); continue; }
    out[k] = merge(out[k], p[k]);
  }
  return out;
}
function applyTopic(name, data, replace) {
  const key = name.replace(/\.z$/, '');
  if (/\.z$/.test(name) && typeof data === 'string') {
    try { data = JSON.parse(zlib.inflateRawSync(Buffer.from(data, 'base64')).toString('utf8')); } catch { return; }
  }
  state[key] = replace ? data : merge(state[key], data);
  schedulePush(key);
}
function handleFrame(ws, frame) {
  let msg;
  try { msg = JSON.parse(frame); } catch {
    try { msg = JSON.parse(frame.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false')); } catch { return; }
  }
  if (msg.error) log('F1 said:', msg.error);
  if (msg.type === undefined && !msg.error) {                                     // handshake accepted: now subscribe
    ws.send(JSON.stringify({type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS]}) + RS);
  } else if (msg.type === 6) {
    ws.send(JSON.stringify({type: 6}) + RS);                                      // ping back
  } else if (msg.type === 3) {                                                    // reply to Subscribe: the full current state
    if (msg.result && typeof msg.result === 'object') { Object.keys(msg.result).forEach(k => applyTopic(k, msg.result[k], true)); log('Subscribed. Topics received:', Object.keys(state).join(', ') || 'none yet'); }
  } else if (msg.type === 1 && msg.target === 'feed' && Array.isArray(msg.arguments)) {
    applyTopic(msg.arguments[0], msg.arguments[1], false);
  } else if (msg.type === 7) { ws.close(); }
}
async function connectOnce() {
  meta.attempts++;
  log('Connecting to F1 live timing…');
  const jar = new Map();
  const absorb = r => listOf(r.headers['set-cookie']).forEach(c => { const kv = String(c).split(';')[0], i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1)); });
  const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
  try { absorb(await request('OPTIONS', F1_HTTP + '/signalrcore/negotiate?negotiateVersion=1')); } catch {}   // gets the load-balancer cookie
  const neg = await request('POST', F1_HTTP + '/signalrcore/negotiate?negotiateVersion=1', {'Content-Length': 0, Cookie: cookie()});
  absorb(neg);
  if (neg.status !== 200) throw new Error('negotiate answered HTTP ' + neg.status + ' ' + neg.body.slice(0, 160));
  const info = JSON.parse(neg.body), token = info.connectionToken || info.connectionId;
  if (!token) throw new Error('negotiate gave no connection token');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(F1_WS + '/signalrcore?id=' + encodeURIComponent(token), {headers: {'User-Agent': UA, 'Accept-Encoding': 'gzip, identity', Cookie: cookie()}});
    currentWs = ws;
    let opened = false;
    const watchdog = setInterval(() => { if (meta.connected && Date.now() - meta.lastMsg > 60000) { log('No data for 60 s, reconnecting'); ws.terminate(); } }, 10000);
    ws.on('open', () => { opened = true; meta.connected = true; log('Connected to F1. Waiting for data…'); meta.since = Date.now(); meta.lastMsg = Date.now(); meta.error = ''; ws.send(JSON.stringify({protocol: 'json', version: 1}) + RS); });
    ws.on('message', data => { meta.lastMsg = Date.now(); meta.msgCount++; String(data).split(RS).filter(Boolean).forEach(f => handleFrame(ws, f)); });
    ws.on('error', e => { meta.error = e.message; log('Socket error:', e.message); });
    ws.on('unexpected-response', (req, res) => { meta.error = 'F1 refused the connection (HTTP ' + res.statusCode + ')'; log(meta.error); });
    ws.on('close', code => { clearInterval(watchdog); if (currentWs === ws) currentWs = null; meta.connected = false; log('F1 connection closed (code ' + code + ')'); opened ? resolve(code) : reject(new Error(meta.error || 'socket closed before opening')); });
  });
}
async function run() {                               // started once the local server is listening
  let delay = 2000;
  for (;;) {
    try { await connectOnce(); delay = 2000; } catch (e) { meta.error = e.message; log('Connection failed:', e.message); }
    meta.connected = false;
    log('Reconnecting in', Math.round(delay / 1000), 's');
    await sleep(delay); delay = Math.min(30000, delay * 1.7);
  }
}

/* ---------- friendly leaderboard (same shape the app reads) ---------- */
function buildTiming() {
  const dl = state.DriverList || {}, lines = (state.TimingData || {}).Lines || {}, app = (state.TimingAppData || {}).Lines || {};
  const drivers = Object.keys(lines).filter(n => lines[n] && typeof lines[n] === 'object').map(n => {
    const l = lines[n], d = dl[n] || {}, stints = listOf((app[n] || {}).Stints), cur = stints[stints.length - 1] || {};
    return {
      driver_number: String(n), name: d.FullName || d.BroadcastName || '', acronym: d.Tla || '', team: d.TeamName || '', team_colour: d.TeamColour || '', headshot_url: d.HeadshotUrl || '',
      position: l.Position, gap_to_leader: l.GapToLeader != null ? l.GapToLeader : '', interval: (l.IntervalToPositionAhead || {}).Value || '',
      last_lap_time: (l.LastLapTime || {}).Value || '', best_lap_time: (l.BestLapTime || {}).Value || '',
      tyre_compound: cur.Compound || '', tyre_laps: cur.TotalLaps != null ? +cur.TotalLaps + (+cur.StartLaps || 0) : null, tyre_new: String(cur.New) === 'true', pit_stops: l.NumberOfPitStops != null ? +l.NumberOfPitStops : null, laps: l.NumberOfLaps != null ? +l.NumberOfLaps : null,
      last_lap_overall_best: !!(l.LastLapTime || {}).OverallFastest, last_lap_personal_best: !!(l.LastLapTime || {}).PersonalFastest, in_pit: !!l.InPit, pit_out: !!l.PitOut, retired: !!l.Retired, stopped: !!l.Stopped,
      sectors: listOf(l.Sectors).map(s => ({value: (s && s.Value) || ''})), speed_traps: {st: l.Speeds && l.Speeds.ST ? l.Speeds.ST.Value : ''}
    };
  }).sort((a, b) => (parseInt(a.position, 10) || 99) - (parseInt(b.position, 10) || 99));
  return {timestamp: new Date().toISOString(), session: (state.SessionInfo || {}).Name || '', drivers};
}

/* ---------- local web server for the app ---------- */
const clients = new Set(), stateClients = new Set();
const HEAVY = new Set(['TimingData', 'TimingAppData', 'TimingStats', 'TopThree']);        // leaderboard topics, sent on their own stream
let pushTimer = null, statePushTimer = null;
function lightState() { const o = {}; Object.keys(state).forEach(k => { if (!HEAVY.has(k)) o[k] = state[k]; }); return o; }
function schedulePush(topic) {
  if (!pushTimer && clients.size) pushTimer = setTimeout(() => { pushTimer = null; const payload = 'data: ' + JSON.stringify(buildTiming()) + '\n\n'; clients.forEach(r => r.write(payload)); }, 100);
  if (!HEAVY.has(topic) && !statePushTimer && stateClients.size) statePushTimer = setTimeout(() => { statePushTimer = null; const payload = 'data: ' + JSON.stringify(lightState()) + '\n\n'; stateClients.forEach(r => r.write(payload)); }, 50);
}
setInterval(() => { clients.forEach(r => r.write(': keepalive\n\n')); stateClients.forEach(r => r.write(': keepalive\n\n')); }, 15000);

// Team radio clips live on F1's servers without CORS headers. This lets the app fetch them (for speech-to-text and playback).
function proxyAudio(req, res) {
  const target = new URL(req.url, 'http://x').searchParams.get('u') || '';
  let u; try { u = new URL(target); } catch { res.writeHead(400, CORS); return res.end('bad url'); }
  if (u.protocol !== 'https:' || u.hostname !== 'livetiming.formula1.com' || !u.pathname.startsWith('/static/')) { res.writeHead(403, CORS); return res.end('only F1 static audio is allowed'); }
  const headers = {'User-Agent': UA}; if (req.headers.range) headers.Range = req.headers.range;
  https.get(u, {headers}, up => {
    const h = {...CORS}; ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(k => { if (up.headers[k]) h[k] = up.headers[k]; });
    res.writeHead(up.statusCode, h); up.pipe(res);
  }).on('error', e => { res.writeHead(502, CORS); res.end('upstream error: ' + e.message); });
}
const CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Private-Network': 'true', 'Cache-Control': 'no-store'};
http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const json = (obj, code = 200) => { res.writeHead(code, {...CORS, 'Content-Type': 'application/json'}); res.end(JSON.stringify(obj)); };
  if (path === '/snapshot') return json(state);
  if (path === '/log') {
    const since = +new URL(req.url, 'http://x').searchParams.get('since') || 0;
    return json({seq: logSeq, lines: LOG.filter(l => l.n > since)});
  }
  if (path === '/reconnect') {
    if (req.method !== 'POST') return json({error: 'use POST'}, 405);
    log('Reconnect requested from the app');
    if (currentWs) { try { currentWs.terminate(); } catch {} }
    return json({ok: true, hadConnection: !!currentWs});
  }
  if (path === '/audio') return proxyAudio(req, res);
  if (path === '/stream/state') {
    res.writeHead(200, {...CORS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive'});
    res.write('event: snapshot\ndata: ' + JSON.stringify(lightState()) + '\n\n');
    stateClients.add(res); req.on('close', () => stateClients.delete(res));
    return;
  }
  if (path === '/' || path === '/app') {
    const file = nodePath.join(__dirname, 'f1-race-watch.html');
    if (fs.existsSync(file)) { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}); return fs.createReadStream(file).pipe(res); }
  }
  if (path === '/timing') return json(buildTiming());
  if (path === '/stream/timing') {
    res.writeHead(200, {...CORS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive'});
    res.write('event: snapshot\ndata: ' + JSON.stringify(buildTiming()) + '\n\n');
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (path === '/' || path === '/status') {              // (only reached for / when f1-race-watch.html is not next to this file)
    if (path === '/' && req.method === 'GET') { res.writeHead(302, {...CORS, Location: '/status'}); return res.end(); }
    const hb = state.Heartbeat && state.Heartbeat.Utc, si = state.SessionInfo || {};
    return json({relay: 'f1-relay', version: VERSION, port: PORT, uptimeSeconds: Math.round((Date.now() - STARTED) / 1000), node: process.version, appFile: fs.existsSync(nodePath.join(__dirname, 'f1-race-watch.html')), connectedToF1: meta.connected, lastMessageSecondsAgo: meta.lastMsg ? Math.round((Date.now() - meta.lastMsg) / 1000) : null, messages: meta.msgCount, attempts: meta.attempts, lastError: meta.error || null,
      session: si.Meeting ? si.Meeting.Name + ' · ' + (si.Name || si.Type) : null, lastHeartbeat: hb || null, topics: Object.keys(state), drivers: buildTiming().drivers.length});
  }
  json({error: 'not found'}, 404);
}).listen(PORT, () => {
  log('Relay ' + VERSION + ' running. The app is at  http://localhost:' + PORT);
  log('Leave this window open during the race. Close it (or press Ctrl+C) to stop the relay.');
  if (OPEN) openBrowser('http://localhost:' + PORT + '/');
  run();
}).on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('A relay is already running on port ' + PORT + '.' + (OPEN ? ' Opening the app instead.' : ' To use another port: set PORT=3001 and start again.'));
    if (OPEN) { openBrowser('http://localhost:' + PORT + '/'); setTimeout(() => process.exit(0), 1500); return; }
  } else console.error(e.message);
  process.exit(1);
});
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
  exec(cmd, err => { if (err) log('Could not open the browser automatically. Open ' + url + ' yourself.'); });
}
