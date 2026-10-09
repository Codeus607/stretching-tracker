'use strict';

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());
const thisMonth = () => today().slice(0, 7);
const monthName = m => new Date(m + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }).toLowerCase();
const dayName = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toLowerCase();
const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtTime = secs => {
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`;
};
const READY_MS = 5000;
const STRETCH_MS = 60000;

const S = {
  stretches: [], sessions: [], view: 'list',
  picked: load('str-picked') || [], // stretch ids in the order they were tapped
  run: null, // the running session, see start()
  timer: null, lastSent: 0, wake: null, ctx: null,
};

function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }

const logged = () => S.sessions.filter(s => s.seconds > 0);
function monthTotals(m) {
  const ss = logged().filter(s => s.date.startsWith(m));
  return { secs: ss.reduce((t, s) => t + s.seconds, 0), days: new Set(ss.map(s => s.date)).size, n: ss.length };
}
function dayTotals(m) {
  const days = {};
  for (const s of logged().filter(s => s.date.startsWith(m))) {
    const d = days[s.date] ||= { secs: 0, names: [] };
    d.secs += s.seconds;
    d.names.push(...s.stretches);
  }
  return Object.entries(days).sort((a, b) => b[0].localeCompare(a[0]));
}
// consecutive days (ending today or yesterday) with some stretching
function streak() {
  const days = new Set(logged().map(s => s.date));
  const d = new Date();
  if (!days.has(iso(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(iso(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
const byId = id => S.stretches.find(s => s.id === id);
const pickedStretches = () => S.picked.map(byId).filter(Boolean);

// ---------- api ----------
async function api(action, body, keepalive = false) {
  const opts = body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'Content-Type': 'application/json', 'X-Str': '1' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch('api.php?a=' + action, opts); }
  catch { throw new Error('No connection to the server'); }
  let data = {};
  try { data = await res.json(); } catch { }
  if (res.status === 401 && action !== 'login') { renderLogin(); throw new Error('Not logged in'); }
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
  return data;
}

async function run(fn) {
  try { await fn(); } catch (e) { if (e.message !== 'Not logged in') toast(e.message, true); }
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- chime ----------
// A small synthesised bell. The AudioContext has to be created inside a tap (iOS).
function audioCtx() {
  if (!S.ctx) {
    // play over the silent switch, briefly ducking any music that's playing
    try { if (navigator.audioSession) navigator.audioSession.type = 'transient'; } catch { }
    S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (S.ctx.state === 'suspended') S.ctx.resume();
  return S.ctx;
}

// `small` is the short, higher ding that marks the end of a stretch
function chime(times = 1, small = false) {
  const ctx = S.ctx;
  if (!ctx) return;
  const partials = small ? [[1760, 0.14, 0.7], [2640, 0.05, 0.4]] : [[880, 0.22, 1.6], [1320, 0.09, 1.1], [2210, 0.04, 0.6]];
  for (let i = 0; i < times; i++) {
    const t0 = ctx.currentTime + 0.05 + i * 0.55;
    for (const [f, g, d] of partials) {
      const o = ctx.createOscillator(), v = ctx.createGain();
      o.frequency.value = f;
      v.gain.setValueAtTime(0.0001, t0);
      v.gain.exponentialRampToValueAtTime(g, t0 + 0.01);
      v.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(v).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + d + 0.05);
    }
  }
}

// keep the screen on while stretching
async function keepAwake(on) {
  try {
    if (on && !S.wake && 'wakeLock' in navigator) {
      S.wake = await navigator.wakeLock.request('screen');
      S.wake.addEventListener('release', () => { S.wake = null; });
    } else if (!on && S.wake) {
      await S.wake.release();
    }
  } catch { }
}

// ---------- session engine ----------
// Each stretch is a 5 s get-ready followed by 60 s of stretching. Time is taken
// from the clock, not from counting ticks, so a frozen page catches up correctly.
const phaseLen = () => S.run.phase === 'ready' ? READY_MS : STRETCH_MS;
const phaseMs = () => S.run.acc + (S.run.since ? Date.now() - S.run.since : 0);
const stretchedSecs = () => {
  const r = S.run;
  return r ? Math.floor((r.stretchedMs + (r.phase === 'stretch' ? Math.min(phaseMs(), STRETCH_MS) : 0)) / 1000) : 0;
};
const paused = () => !S.run.since;

async function start() {
  const list = pickedStretches();
  if (!list.length) return;
  audioCtx(); // must happen inside the tap
  const { session } = await api('session_start', { stretches: list.map(s => s.name) });
  S.sessions.push(session);
  S.run = { id: session.id, list, idx: 0, phase: 'ready', acc: 0, since: Date.now(), stretchedMs: 0, ended: false, stopped: false };
  S.lastSent = Date.now();
  keepAwake(true);
  S.view = 'player';
  render();
  clearInterval(S.timer);
  S.timer = setInterval(tick, 200);
}

// move to the next phase; `over` is how far we already are into it
function advance(over, fresh) {
  const r = S.run;
  if (r.phase === 'ready') {
    r.phase = 'stretch';
    if (fresh) chime();
  } else {
    r.stretchedMs += STRETCH_MS;
    if (r.idx + 1 >= r.list.length) { r.phase = 'end'; finish(false); return false; }
    r.idx++;
    r.phase = 'ready';
    if (fresh) chime(1, true);
  }
  r.acc = over;
  r.since = r.since ? Date.now() : null;
  return true;
}

function tick() {
  const r = S.run;
  if (!r || r.ended) return;
  let changed = false;
  while (phaseMs() >= phaseLen()) {
    const over = phaseMs() - phaseLen();
    if (!advance(over, over < 1500)) return;
    changed = true;
  }
  if (changed) syncVideo();
  if (Date.now() - S.lastSent > 15000) report();
  paintPlayer();
}

function pauseToggle() {
  const r = S.run;
  if (paused()) { audioCtx(); r.since = Date.now(); }
  else { r.acc = phaseMs(); r.since = null; report(); }
  syncVideo();
  paintPlayer();
}

function skip() {
  const r = S.run;
  if (r.phase === 'ready') {
    r.acc = 0;
    r.phase = 'stretch';
    if (!paused()) { r.since = Date.now(); chime(); }
  } else {
    r.stretchedMs += Math.min(phaseMs(), STRETCH_MS);
    if (r.idx + 1 >= r.list.length) { r.phase = 'end'; finish(false); return; }
    r.idx++;
    r.phase = 'ready';
    r.acc = 0;
    if (!paused()) r.since = Date.now();
  }
  syncVideo();
  paintPlayer();
}

// send progress; the server keeps the maximum, so repeats are harmless
function report() {
  const r = S.run;
  if (!r) return Promise.resolve();
  S.lastSent = Date.now();
  const body = { id: r.id, seconds: stretchedSecs(), completed: r.ended && !r.stopped };
  return api('session_update', body, true).then(res => {
    const i = S.sessions.findIndex(s => s.id === res.session.id);
    if (i >= 0) S.sessions[i] = res.session;
  }).catch(() => { });
}

async function finish(stopped) {
  const r = S.run;
  if (!r || r.ended) return;
  r.acc = phaseMs(); // freeze the clock
  r.ended = true;
  r.stopped = stopped;
  r.since = null;
  clearInterval(S.timer);
  if (!stopped) chime(2);
  keepAwake(false);
  await report();
  S.view = 'done';
  render();
}

document.addEventListener('visibilitychange', () => {
  if (!S.run || S.run.ended) return;
  if (document.visibilityState === 'hidden') report();
  else { keepAwake(true); tick(); syncVideo(); }
});
window.addEventListener('pagehide', () => { if (S.run && !S.run.ended) report(); });

// the video always shows the current (or upcoming) stretch, looping
function syncVideo() {
  const v = $('#vid'), r = S.run;
  if (!v || !r) return;
  const s = r.list[r.idx];
  if (v.dataset.id !== s.id) {
    v.dataset.id = s.id;
    v.poster = s.poster;
    v.src = s.video;
  }
  if (paused()) v.pause();
  else v.play().catch(() => { });
}

// ---------- views ----------
function render() {
  $('#statsLink').hidden = false;
  const v = S.view;
  $('#app').innerHTML = v === 'player' ? viewPlayer()
    : v === 'done' ? viewDone()
    : v === 'stats' ? viewStats()
    : viewList();
  if (v === 'player') { syncVideo(); paintPlayer(); }
  window.scrollTo(0, 0);
}

function renderLogin() {
  $('#statsLink').hidden = true;
  $('#app').innerHTML = `
    <div class="login">
      <h1>login</h1>
      <p>// same password as fitness</p>
      <form id="loginForm">
        <input type="password" id="pw" autocomplete="current-password" placeholder="password" required>
        <button class="btn block">enter</button>
      </form>
    </div>`;
  $('#pw').focus();
}

function viewList() {
  const t = monthTotals(thisMonth());
  const n = pickedStretches().length;
  return `
    <p class="meta">this month · <b class="hl">${fmtTime(t.secs)}</b> · ${t.days} day${t.days === 1 ? '' : 's'}</p>
    <h2>random session</h2>
    <div class="quick">
      ${[10, 15].map(m => `<button class="dur" data-act="random" data-min="${m}">${m}<small>min</small></button>`).join('')}
    </div>
    <div class="list-head">
      <h2>stretches</h2>
      <span class="meta-links">
        <a href="#" data-act="all">[all]</a>
        <a href="#" data-act="clear">[clear]</a>
      </span>
    </div>
    ${S.stretches.length ? S.stretches.map(s => {
      const i = S.picked.indexOf(s.id);
      return `<button class="stretch ${i >= 0 ? 'on' : ''}" data-act="pick" data-id="${esc(s.id)}">
        <img src="${esc(s.poster)}" alt="" loading="lazy">
        <span class="t">${esc(s.name)}</span>
        <span class="num">${i >= 0 ? i + 1 : ''}</span>
      </button>`;
    }).join('') : '<p class="meta">no stretches yet</p>'}
    <div class="go-bar">
      <button class="btn block go" data-act="start" ${n ? '' : 'disabled'}>${n ? `START · ${n} stretch${n === 1 ? '' : 'es'} · ${n} min` : 'pick your stretches'}</button>
    </div>
    <p class="meta center">1 min each · 5 s to get ready · a chime starts each stretch, a short ding ends it</p>`;
}

function viewPlayer() {
  return `
    <div class="player">
      <div class="what" id="what"></div>
      <div class="video-box">
        <video id="vid" muted loop playsinline autoplay preload="auto"></video>
        <div class="ready" id="ready" hidden><span class="k">get ready</span><span class="n" id="readyN"></span></div>
      </div>
      <div class="name" id="name"></div>
      <div class="big" id="remain">--:--</div>
      <div class="bar"><div id="prog"></div></div>
      <div class="next meta" id="next"></div>
      <div class="controls">
        <button class="btn" id="pp" data-act="toggle">pause</button>
        <button class="btn" data-act="skip">skip ›</button>
      </div>
      <button class="btn ghost" data-act="stop" style="margin-top:10px">end session</button>
    </div>`;
}

function paintPlayer() {
  const r = S.run;
  if (!r || !$('#remain')) return;
  const s = r.list[r.idx], next = r.list[r.idx + 1];
  const ms = Math.min(phaseMs(), phaseLen());
  const ready = r.phase === 'ready';
  $('#what').textContent = `${r.idx + 1} / ${r.list.length}${paused() ? ' · paused' : ''}`;
  $('#name').textContent = s.name;
  $('#ready').hidden = !ready;
  $('#readyN').textContent = Math.ceil((READY_MS - ms) / 1000);
  $('#remain').textContent = mmss(Math.ceil(((ready ? STRETCH_MS : STRETCH_MS - ms)) / 1000));
  $('#prog').style.width = `${ready ? 0 : (ms / STRETCH_MS) * 100}%`;
  $('#next').textContent = next ? `next: ${next.name}` : 'last one';
  $('#pp').textContent = paused() ? 'resume' : 'pause';
}

function viewDone() {
  const r = S.run;
  const secs = S.sessions.find(s => s.id === r.id)?.seconds ?? stretchedSecs();
  const t = monthTotals(thisMonth());
  const st = streak();
  return `
    <div class="done">
      <div class="check">${r.stopped ? '◼' : '✓'}</div>
      <div class="sum">${mmss(secs)} of stretching${r.stopped ? ' · ended early' : ''}</div>
      <p class="meta">this month · ${fmtTime(t.secs)} · ${t.days} day${t.days === 1 ? '' : 's'}${st > 1 ? ` · ${st}-day streak` : ''}</p>
      <div class="controls" style="margin-top:28px">
        <button class="btn" data-act="list">done</button>
        <button class="btn" data-act="again">again</button>
      </div>
    </div>`;
}

function viewStats() {
  const m = thisMonth();
  const t = monthTotals(m);
  const months = [...new Set(logged().map(s => s.date.slice(0, 7)))].sort().reverse();
  const recent = [...S.sessions].reverse().slice(0, 30);
  const tile = (label, v, small = '') => `<div class="tile"><div class="k">${label}</div><div class="v">${v}${small ? `<small>${small}</small>` : ''}</div></div>`;
  const days = dayTotals(m);
  return `
    <button class="back" data-act="list">← back</button>
    <h1>stats</h1>
    <h2>${esc(monthName(m))}</h2>
    <div class="tiles">
      ${tile('total', fmtTime(t.secs))}
      ${tile('days', t.days)}
      ${tile('sessions', t.n)}
      ${tile('streak', streak(), 'days')}
    </div>
    <h2>days this month</h2>
    <div class="card">
      ${days.length ? days.map(([d, v]) => `
        <div class="sess"><span class="grow">${esc(dayName(d))}<br><span class="muted">${esc([...new Set(v.names)].join(', '))}</span></span><span class="hl">${fmtTime(v.secs)}</span></div>`).join('')
        : '<p class="meta">nothing yet this month</p>'}
    </div>
    <h2>per month</h2>
    <div class="card">
      ${months.length ? `<table class="tbl">
        <thead><tr><th>month</th><th class="num">days</th><th class="num">sessions</th><th class="num">total</th></tr></thead>
        <tbody>${months.map(mm => {
          const a = monthTotals(mm);
          return `<tr><td>${mm}</td><td class="num">${a.days}</td><td class="num">${a.n}</td><td class="num hl">${fmtTime(a.secs)}</td></tr>`;
        }).join('')}</tbody></table>` : '<p class="meta">no sessions yet</p>'}
    </div>
    <h2>recent sessions</h2>
    <div class="card">
      ${recent.length ? recent.map(s => `
        <div class="sess">
          <span class="grow">${s.date} · ${mmss(s.seconds)}${s.completed ? '' : ' · ended early'}<br>
            <span class="muted">${esc(s.stretches.join(', '))}</span></span>
          <button class="x" data-act="del" data-id="${s.id}" aria-label="delete session">×</button>
        </div>`).join('') : '<p class="meta">nothing yet</p>'}
    </div>`;
}

// ---------- events ----------
const running = () => S.run && !S.run.ended;
const actions = {
  list: () => {
    // a running session always comes back to the player
    S.view = running() ? 'player' : 'list';
    if (S.view === 'list') S.run = null;
    render();
  },
  stats: () => { if (running()) return; S.run = null; S.view = 'stats'; render(); },
  pick: el => {
    const id = el.dataset.id, i = S.picked.indexOf(id);
    if (i >= 0) S.picked.splice(i, 1); else S.picked.push(id);
    S.picked = S.picked.filter(byId);
    save('str-picked', S.picked);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  all: () => { S.picked = S.stretches.map(s => s.id); save('str-picked', S.picked); render(); },
  // random stretches for a 10 or 15 min session (one minute each, no repeats), in random order
  random: el => {
    const ids = S.stretches.map(s => s.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    S.picked = ids.slice(0, +el.dataset.min);
    save('str-picked', S.picked);
    render();
    if (S.picked.length < +el.dataset.min) toast(`Only ${S.picked.length} stretches available`);
  },
  clear: () => { S.picked = []; save('str-picked', S.picked); render(); },
  start: el => { el.disabled = true; run(start).finally(() => { el.disabled = false; }); },
  again: el => run(start),
  toggle: pauseToggle,
  skip: skip,
  stop: () => {
    const secs = stretchedSecs();
    if (!confirm(`End the session now? ${mmss(secs)} of stretching will be logged.`)) return;
    run(() => finish(true));
  },
  del: el => run(async () => {
    if (!confirm('Delete this session?')) return;
    await api('session_delete', { id: +el.dataset.id });
    S.sessions = S.sessions.filter(s => s.id !== +el.dataset.id);
    render();
  }),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  actions[el.dataset.act](el);
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'loginForm') return;
  e.preventDefault();
  run(async () => {
    await api('login', { password: $('#pw').value });
    await boot();
  });
});

async function boot() {
  try {
    const [list, data] = await Promise.all([fetch('stretches.json').then(r => r.json()), api('data')]);
    S.stretches = list.stretches;
    S.sessions = data.sessions;
  } catch (e) {
    if (e.message !== 'Not logged in') $('#app').innerHTML = `<p class="center" style="color:var(--red)">${esc(e.message)}</p>`;
    return;
  }
  S.picked = S.picked.filter(byId);
  S.view = 'list';
  render();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
boot();
