/**
 * Reel player — queue, controls, gestures, subtitles, EQ + 3-tier load flow.
 * Tier 1 native → tier 2 RemuxEngine (mediabunny+hls) → tier 3 ffmpeg.wasm.
 */
import {
  RemuxEngine, planTiers, probeSource, ffmpegConvert, playableSmokeTest,
  EngineError, TIER_LABEL, extOf, shutdownEngine,
} from './engine.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = t => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  t = Math.floor(t); const h = (t / 3600) | 0, m = ((t % 3600) / 60) | 0, s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const delay = ms => new Promise(r => setTimeout(r, ms));
const throttle = (fn, ms) => { let t = 0, lastArgs; return (...a) => { lastArgs = a; const n = Date.now(); if (n - t >= ms) { t = n; fn(...lastArgs); } else { clearTimeout(fn._t); fn._t = setTimeout(() => { t = Date.now(); fn(...lastArgs); }, ms - (n - t)); } }; };

const app = $('#app'), v = $('#v'), wrap = $('#wrap');

/* ------------------------------------------------------------------ state */

const S = {
  list: [], cur: -1, seq: 0, gen: 0,
  vol: 1, muted: false, rate: 1,
  shuf: false, rep: 0,               // 0 off · 1 all · 2 one
  sOn: true, subDelay: 0, cues: null,
  f: { b: 100, c: 100, s: 100, h: 0 }, rot: 0, flipX: 1, zoom: 1,
  aspect: 'Fit',
  ab: null,                          // {a,b} loop
  marks: [], stats: false, viz: true,
  hasSrc: false, loading: false,
  menuOpen: false,
};

/* ------------------------------------------------------------------- osd */

let osdT;
function osd(msg) {
  const el = $('#osd'); el.textContent = msg; el.classList.add('on');
  clearTimeout(osdT); osdT = setTimeout(() => el.classList.remove('on'), 1000);
}
let bnrT;
function bnr(msg, ms = 3600) {
  const el = $('#banner'); el.querySelector('span').textContent = msg; el.classList.add('on');
  clearTimeout(bnrT); bnrT = setTimeout(() => el.classList.remove('on'), ms);
}

/* ------------------------------------------------------------- audio graph */

const AC = window.AudioContext || window.webkitAudioContext;
let ac = null, srcNode = null, gainNode = null, analyser = null, filters = [];
const EQ_HZ = [60, 230, 910, 3600, 14000];
const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0], Pop: [-1, 3, 4, 3, -1], Rock: [5, 3, -1, 2, 5],
  Jazz: [3, 1, 0, 1, 3], Classical: [4, 2, 0, 2, 4],
  'Bass boost': [8, 4, 0, 0, 0], 'Treble boost': [0, 0, 0, 4, 8],
};
let eqGains = [...EQ_PRESETS.Flat];

function audioInit() {
  if (!AC || ac) return;
  try {
    ac = new AC();
    srcNode = ac.createMediaElementSource(v);
    filters = EQ_HZ.map((hz, i) => {
      const f = ac.createBiquadFilter();
      f.type = i === 0 ? 'lowshelf' : i === EQ_HZ.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = hz; f.Q.value = 1; f.gain.value = eqGains[i];
      return f;
    });
    gainNode = ac.createGain();
    analyser = ac.createAnalyser(); analyser.fftSize = 128;
    let node = srcNode;
    for (const f of filters) { node.connect(f); node = f; }
    node.connect(gainNode); gainNode.connect(analyser); analyser.connect(ac.destination);
    applyGain();
  } catch (e) { console.warn('[reel] audio graph', e); }
}
function applyGain() {
  const g = S.muted ? 0 : S.vol;
  v.volume = 1;
  if (gainNode) gainNode.gain.value = g;
  else try { v.volume = clamp(g, 0, 1); } catch {}
}
function setVol(x, { silent } = {}) {
  S.vol = clamp(x, 0, 2);
  if (S.vol > 0 && S.muted) S.muted = false;
  applyGain(); syncVolUI();
  if (!silent) osd(`Volume ${Math.round(S.vol * 100)}%`);
}
function setMuted(m) {
  S.muted = m; applyGain(); syncVolUI();
  osd(m ? 'Muted' : `Volume ${Math.round(S.vol * 100)}%`);
}
function syncVolUI() {
  const val = Math.round(S.vol * 100);
  $('#vol').value = val; $('#vol2').value = val; $('#vl').textContent = val + '%';
  $('#bMute use').setAttribute('href', S.muted || S.vol === 0 ? '#i-mute' : '#i-vol');
  $('#bMute').classList.toggle('on', S.muted);
}

/* ------------------------------------------------------------------- queue */

const TIER_CHIP = { 1: ['native', ''], 2: ['remux', ''], 3: ['ffmpeg', 'w'] };

function renderQ() {
  const q = $('#q');
  q.innerHTML = S.list.map((it, i) => {
    const chip = it.err
      ? `<i class="tchip e">failed</i>`
      : it.tier ? `<i class="tchip ${TIER_CHIP[it.tier][1]}">${TIER_CHIP[it.tier][0]}</i>` : '';
    const na = it.noAudio ? '<i class="tchip w">no audio</i>' : '';
    const thumb = it.probe?.thumb
      ? `<img src="${it.probe.thumb}" alt="">`
      : `<div class="ph"><svg class="i"><use href="#i-film"/></svg></div>`;
    return `<div class="qit ${i === S.cur ? 'on' : ''} ${i === S.cur && v.paused ? 'paused' : ''}" draggable="true" data-i="${i}">
      ${thumb}
      <div class="nm"><b>${esc(it.name)}</b>
        <small>${it.dur ? fmt(it.dur) : '—'} ${chip} ${na} ${it.probe?.videoCodec ? esc(shortCodec(it.probe.videoCodec)) : ''}</small></div>
      <button class="x" data-rm="${i}" title="Remove">✕</button>
      <span class="eqb"><i></i><i></i><i></i></span>
    </div>`;
  }).join('');
  $('#qh').style.display = S.list.length ? 'block' : 'none';
  updateStageState();
}

function shortCodec(c) {
  if (!c) return '';
  const m = {
    avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', vp08: 'VP8', vp09: 'VP9',
    av01: 'AV1', mp4v: 'MPEG-4', theora: 'Theora',
    mp4a: 'AAC', ac3: 'AC-3', 'ac-3': 'AC-3', ec3: 'E-AC-3', 'ec-3': 'E-AC-3',
    opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', mp3: 'MP3', 'mp4a.40.2': 'AAC',
    'mp4a.69': 'MP3', 'mp4a.6b': 'AC-3', dtsc: 'DTS',
  };
  const key = String(c).split('.')[0];
  return m[key] || m[c] || String(c).toUpperCase();
}

function updateStageState() {
  $('#empty').classList.toggle('gone', S.list.length > 0);
  $('#bigPlay').classList.toggle('on',
    S.list.length > 0 && !S.hasSrc && !S.loading);
  const cur = S.list[S.cur];
  $('#title').textContent = cur ? cur.name : '';
  $('#title').classList.toggle('on', !!cur);
}

/* ------------------------------------------------------------ add / probe */

function isSub(name) { return /\.(srt|vtt)$/i.test(name); }
function baseName(name) { return String(name).replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '').toLowerCase(); }

function add(items) {
  const vids = [], subs = [];
  for (const raw of items) {
    const it = { id: ++S.seq, name: raw.name, f: raw.f || null, url: raw.url || null, dur: 0 };
    if (!it.url && it.f) it.url = URL.createObjectURL(it.f);
    (isSub(it.name) ? subs : vids).push(it);
  }
  for (const s of subs) attachSub(s, vids);
  if (vids.length) {
    S.list.push(...vids);
    renderQ();
    vids.forEach(scheduleProbe);
    if (S.cur < 0) load(0);
    else bnr(`${vids.length} file${vids.length > 1 ? 's' : ''} added`);
  } else if (subs.length) bnr('Subtitle loaded');
}

function attachSub(sub, vids) {
  const b = baseName(sub.name);
  const target = vids.find(x => baseName(x.name) === b)
    || S.list.find(x => baseName(x.name) === b)
    || S.list[S.cur];
  if (!target) { readSubFile(sub); return; }
  target.subFile = sub;
  if (target === S.list[S.cur] && S.hasSrc) readSubFile(sub);
}

let probeQ = Promise.resolve();
function scheduleProbe(it) {
  probeQ = probeQ.then(() => doProbe(it)).catch(() => {});
}
async function doProbe(it) {
  if (it.probe || it.dead) return;
  const p = await probeSource(it.f || it.url);
  if (it.dead) return;
  it.probe = p;
  if (p.readable && !it.dur) it.dur = p.duration;
  renderQ();
  if (S.list[S.cur] === it) updateInfo();
}

/* ---------------------------------------------------------------- load flow */

const engine = new RemuxEngine(v, {
  onPhase: onEnginePhase,
  onProgress: onEngineProgress,
  onError: onEngineError,
});

const SHORT_TIER = { 1: 'Native', 2: 'Remux', 3: 'Convert' };

function planFor(it) {
  let tiers = planTiers(it.name);
  if (!it.f) tiers = tiers.filter(t => t !== 3);   // remote URLs can't be converted
  const attempts = tiers.map(t => ({ tier: t, noAudio: false }));
  if (tiers.includes(2)) attempts.push({ tier: 2, noAudio: true });
  return attempts;
}

async function load(i, keepAttempt = false) {
  const it = S.list[i];
  if (!it) return;
  const gen = ++S.gen;
  stopPlayback();
  S.cur = i;
  it.err = null;
  if (!it.attempts || !keepAttempt) { it.attempts = planFor(it); it.attempt = 0; it.failMarks = new Set(); }
  audioInit(); ac?.resume?.().catch(() => {});
  S.cues = null; $('#sub').textContent = '';
  $('#badge').classList.remove('on', 'ok', 'warn');
  if (it.subFile) readSubFile(it.subFile);
  renderQ();
  if (matchMedia('(max-width:900px)').matches) closeDrawer();
  runAttempt(it, gen);
}

function stopPlayback() {
  S.loading = false;
  S.ctrl?.abort();
  $('#load').classList.remove('on');
  S.hasSrc = false;
  try { v.pause(); } catch {}
  try { engine.destroy(); } catch {}
  v.removeAttribute('src');
  try { v.load(); } catch {}
}

async function runAttempt(it, gen) {
  if (gen !== S.gen || it.attempt >= it.attempts.length) { if (gen === S.gen) failAll(it, gen); return; }
  const a = it.attempts[it.attempt];
  const ctrl = new AbortController(); S.ctrl = ctrl;
  it._failing = false;
  S.loading = true;
  showLoad(it, a);
  try {
    if (a.tier === 1) {
      await nativeLoad(it, ctrl);
      it.tier = 1;
    } else if (a.tier === 2) {
      v.removeAttribute('src'); v.load();
      await engine.load(it.f || it.url, {
        audioIndex: it.ai || 0, audioDisabled: a.noAudio, resumeAt: 0,
      });
      if (ctrl.signal.aborted || gen !== S.gen) throw new EngineError('cancelled', 'cancelled');
      it.tier = 2;
      it.info = engine.info;
      it.noAudio = !!a.noAudio || engine.info.audioDisabled;
    } else {
      const res = await ffmpegConvert(it.f, {
        signal: ctrl.signal, verify: playableSmokeTest,
        onProgress: p => { if (gen === S.gen) convertProgress(p, it); },
      });
      if (ctrl.signal.aborted || gen !== S.gen) throw new EngineError('cancelled', 'cancelled');
      it.convertedBlob = res.blob;
      it.convertedURL = URL.createObjectURL(res.blob);
      it.mode = res.mode;
      await nativeLoad(it, ctrl, it.convertedURL);
      it.tier = 3;
      probeSource(res.blob).then(p => {
        it.probe = { ...p, thumb: p.thumb || it.probe?.thumb };
        if (p.readable) it.dur = p.duration || it.dur;
        renderQ(); if (S.list[S.cur] === it) updateInfo();
      }).catch(() => {});
    }
    if (gen !== S.gen) return;
    hideLoad();
    onReady(it, a);
  } catch (e) {
    if (gen !== S.gen || ctrl.signal.aborted ||
        e?.code === 'cancelled' || e?.name === 'AbortError') return;
    escalate(it, gen, a, e);
  }
}

function nativeLoad(it, ctrl, src) {
  src = src || it.url;
  return new Promise((res, rej) => {
    let done = false;
    const ok = () => { if (!done) { done = true; cl(); res(); } };
    const bad = () => { if (!done) { done = true; cl(); rej(new EngineError('codec', 'The browser could not decode this file')); } };
    const cl = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); };
    v.addEventListener('loadedmetadata', ok);
    v.addEventListener('error', bad);
    if (/^https?:/.test(src)) v.crossOrigin = 'anonymous';
    else v.removeAttribute('crossorigin');
    v.src = src;
    v.load();
    setTimeout(() => { if (!done && (v.error || v.readyState === 0)) bad(); }, 45000);
  });
}

function escalate(it, gen, a, err) {
  if (it._failing || gen !== S.gen) return;
  it._failing = true;
  console.warn('[reel] tier failed:', a.tier, err);
  try { engine.destroy(); } catch {}
  it.failMarks.add(it.attempt);
  it.attempt++;
  if (it.attempt < it.attempts.length) {
    S.loading = true;
    const next = it.attempts[it.attempt];
    showLoad(it, next);
    $('#ldSub').textContent =
      `${TIER_LABEL[a.tier]} failed (${shortErr(err)}) — trying ${SHORT_TIER[next.tier].toLowerCase()}…`;
    renderTiers(it);
    setTimeout(() => { if (gen === S.gen) runAttempt(it, gen); }, 1100);
  } else failAll(it, gen, err);
}

function shortErr(e) {
  const m = e?.message || String(e || 'unknown error');
  return m.length > 90 ? m.slice(0, 88) + '…' : m;
}

function failAll(it, gen, err) {
  if (gen !== S.gen) return;
  S.loading = false;
  S.hasSrc = false;
  hideLoad();
  it.err = shortErr(err) || 'not playable';
  bnr(`Can’t play “${it.name}” — ${it.err}`, 6000);
  renderQ();
  updateInfo();
}

function onReady(it, a) {
  S.loading = false;
  S.hasSrc = true;
  it.err = null;
  renderQ();
  setBadge(it, a);
  updateInfo();
  updateMediaSession();
  renderAudioTracks(it);
  v.play().catch(e => { if (e?.name !== 'AbortError') osd('Press ▶ to play'); });
}

function setBadge(it, a) {
  const b = $('#badge');
  const ext = extOf(it.name) || 'media';
  let txt = ext, cls = '';
  if (a.tier === 2) {
    cls = it.noAudio ? 'warn' : 'ok';
    txt += it.noAudio ? ' · remux, silent' : (it.info?.audioTranscoded ? ' · remux + AAC' : ' · remux');
  } else if (a.tier === 3) {
    cls = 'warn';
    txt += ' · ' + ({ remux: 'stream copy', x264: 'H.264', mpeg4: 'MPEG-4' }[it.mode] || 'converted');
  } else {
    const p = it.probe;
    if (p?.videoCodec) txt += ' · ' + shortCodec(p.videoCodec);
    if (p?.audioCodec) txt += ' / ' + shortCodec(p.audioCodec);
  }
  b.textContent = txt;
  b.className = 'on ' + cls;
  b.title = TIER_LABEL[a.tier];
}

/* ---------------------------------------------------------- loading overlay */

function showLoad(it, a) {
  const L = $('#load');
  L.classList.add('on');
  $('#ldCancel').hidden = false;
  ringIndet();
  $('#ldTxt').textContent = `Preparing “${it.name}”`;
  $('#ldSub').textContent = TIER_LABEL[a.tier] + (a.noAudio ? ' · without audio' : '');
  renderTiers(it);
  updateStageState();
}
function hideLoad() {
  $('#load').classList.remove('on');
  updateStageState();
}
function renderTiers(it) {
  $('#ldTiers').innerHTML = it.attempts.map((a, i) => {
    let cls = i < it.attempt ? 'done' : i === it.attempt ? 'on' : '';
    if (it.failMarks?.has(i)) cls = 'fail';
    return `<i class="${cls}">${SHORT_TIER[a.tier]}${a.noAudio ? ' −A' : ''}</i>`;
  }).join('');
}
function ringIndet() {
  $('#ring').classList.add('indet');
  $('#ldPct').textContent = '';
}
function ringPct(p) {
  const ring = $('#ring');
  ring.classList.remove('indet');
  ring.querySelector('.p').style.strokeDashoffset = String(301.6 * (1 - clamp(p, 0, 1)));
  $('#ldPct').textContent = Math.round(p * 100) + '%';
}
function onEnginePhase(phase, pct) {
  if (!S.loading) return;
  const txt = $('#ldTxt'), sub = $('#ldSub');
  if (phase === 'probe') { txt.textContent = 'Analyzing file…'; ringIndet(); }
  else if (phase === 'audio-core') {
    txt.textContent = 'Loading audio converter…';
    sub.textContent = '1.9 MB one-time download — converts AC-3/DTS to AAC';
    ringIndet();
  } else if (phase === 'index') {
    txt.textContent = 'Indexing keyframes…';
    if (typeof pct === 'number') ringPct(pct); else ringIndet();
  } else if (phase === 'prepare') { txt.textContent = 'Preparing first segment…'; ringIndet(); }
  else if (phase === 'ready') { txt.textContent = 'Starting playback…'; ringPct(1); }
}
function onEngineProgress(p) {
  if (!S.loading) return;
  const label = { remux: 'Remuxing (stream copy)', x264: 'Encoding H.264 — this can take a while', mpeg4: 'Encoding MPEG-4' }[p.mode] || 'Converting';
  $('#ldTxt').textContent = label;
  if (typeof p.progress === 'number') {
    ringPct(p.progress);
    $('#ldSub').textContent = 'Runs entirely on your device · nothing is uploaded';
  } else if (p.elapsed) {
    $('#ldSub').textContent = `${p.elapsed.toFixed(1)}s elapsed · on-device conversion`;
  }
}
function convertProgress(p, it) { onEngineProgress(p); }

function onEngineError(e) {
  const it = S.list[S.cur];
  if (!it || it.tier !== 2 || it._failing) return;
  escalate(it, S.gen, { tier: 2, noAudio: !!it.noAudio }, e);
}

$('#ldCancel').addEventListener('click', () => {
  const gen = S.gen;
  S.ctrl?.abort();
  try { engine.destroy(); } catch {}
  S.gen++;
  stopPlayback();
  hideLoad();
  bnr('Load cancelled');
  updateStageState();
});

/* ---------------------------------------------------------------- load: ready */

function onMeta() {
  const it = S.list[S.cur];
  if (!it) return;
  if (Number.isFinite(v.duration) && v.duration > 0) it.dur = v.duration;
  layout();
  // resume
  const key = resumeKey(it);
  const saved = +(localStorage.getItem(key) || 0);
  if (saved > 5 && v.duration && saved < v.duration - 10) {
    try { v.currentTime = saved; } catch {}
    osd('Resumed at ' + fmt(saved));
  }
  renderQ(); updateInfo();
}
v.addEventListener('loadedmetadata', onMeta);

v.addEventListener('play', () => {
  syncPlayIcon(); wake(); ac?.resume?.().catch(() => {});
  $('#bigPlay').classList.remove('on');
  renderQ();
});
v.addEventListener('pause', () => { syncPlayIcon(); renderQ(); wake(); });
v.addEventListener('timeupdate', tick);
v.addEventListener('progress', tick);
v.addEventListener('durationchange', tick);
v.addEventListener('playing', () => { if (S.bufing) hideBuf(); });
v.addEventListener('waiting', () => { if (!S.loading) showBuf(); });
v.addEventListener('ended', onEnded);
v.addEventListener('error', () => {
  if (S.loading) return;                    // nativeLoad's own handler escalates
  if (S.hasSrc) bnr('Playback error — ' + (v.error ? v.error.code : 'unknown'), 4000);
});

let bufT;
function showBuf() {
  clearTimeout(bufT);
  bufT = setTimeout(() => {
    if (S.loading || v.readyState >= 3) return;
    S.bufing = true;
    $('#ldTxt').textContent = 'Buffering…';
    $('#ldSub').textContent = '';
    $('#ldCancel').hidden = true;
    ringIndet();
    $('#load').classList.add('on');
  }, 400);
}
function hideBuf() {
  clearTimeout(bufT);
  if (S.loading) return;
  if (!S.bufing) return;
  S.bufing = false;
  $('#load').classList.remove('on');
  updateStageState();
}

function onEnded() {
  if (S.ab && Number.isFinite(S.ab.b)) { v.currentTime = S.ab.a; v.play().catch(() => {}); return; }
  if (S.rep === 2) { v.currentTime = 0; v.play().catch(() => {}); return; }
  next(true);
}
function next(auto = false) {
  if (!S.list.length) return;
  let i;
  if (S.shuf && S.list.length > 1) {
    do { i = (Math.random() * S.list.length) | 0; } while (i === S.cur);
  } else i = S.cur + 1;
  if (i >= S.list.length) {
    if (S.rep === 1) i = 0;
    else { if (auto) { osd('End of queue'); updateStageState(); } return; }
  }
  load(i);
}
function prev() {
  if (!S.list.length) return;
  if (v.currentTime > 4) { v.currentTime = 0; return; }
  load(Math.max(0, S.cur - 1));
}

/* -------------------------------------------------------------------- tick */

const resumeKey = it => `reel:pos:${it.name}:${it.f?.size || 0}`;
let saveT = 0;
function tick() {
  const it = S.list[S.cur];
  const d = v.duration || it?.dur || 0;
  $('#tm').textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
  const p = d ? (v.currentTime / d) * 100 : 0;
  $('#pg').style.width = p + '%';
  let bp = 0;
  try { if (v.buffered.length) bp = (v.buffered.end(v.buffered.length - 1) / d) * 100; } catch {}
  $('#bf').style.width = clamp(bp, 0, 100) + '%';
  if (S.ab && d) {
    $('#ab').style.left = (S.ab.a / d) * 100 + '%';
    $('#ab').style.width = Math.max(0, ((S.ab.b - S.ab.a) / d) * 100) + '%';
    if (v.currentTime >= S.ab.b) { v.currentTime = S.ab.a; v.play().catch(() => {}); }
  }
  drawSubs();
  drawMarks(d);
  if (S.stats) drawStats();
  if (it && !v.paused && Date.now() - saveT > 3000) {
    saveT = Date.now();
    try { localStorage.setItem(resumeKey(it), String(v.currentTime)); } catch {}
  }
}

/* ------------------------------------------------------------------- viz */

let vizData = null;
function drawViz() {
  const el = $('#viz');
  const show = S.viz && analyser && !v.paused && v.videoWidth === 0;
  if (!show) { el.style.display = 'none'; return; }
  if (!vizData || vizData.length !== analyser.frequencyBinCount) vizData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(vizData);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  if (el.width !== (w * dpr) | 0) { el.width = (w * dpr) | 0; el.height = (h * dpr) | 0; }
  const c = el.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const n = vizData.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    const barH = (vizData[i] / 255) * h * 0.9;
    c.fillStyle = `rgba(255,255,255,${0.25 + (vizData[i] / 255) * 0.6})`;
    c.fillRect(i * bw, h - barH, Math.max(1, bw - 2), barH);
  }
  el.style.display = 'block';
}
function vizLoop() { requestAnimationFrame(vizLoop); if (S.viz) drawViz(); }

/* ---------------------------------------------------------------- subtitles */function parseCues(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    let idx = lines.findIndex(l => l.includes('-->'));
    if (idx < 0) continue;
    const m = lines[idx].match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!m) continue;
    const t = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +String(ms).padEnd(3, '0') / 1000;
    cues.push({
      a: t(m[1], m[2], m[3], m[4]), b: t(m[5], m[6], m[7], m[8]),
      text: lines.slice(idx + 1).join('\n').trim(),
    });
  }
  return cues;
}
async function readSubFile(sub) {
  try {
    const text = await sub.f.text();
    const cues = parseCues(text);
    S.cues = cues;
    osd(`Subtitles: ${cues.length} cues`);
  } catch { osd('Could not read subtitles'); }
}
function drawSubs() {
  const el = $('#sub');
  if (!S.sOn || !S.cues?.length) { if (el.textContent) el.textContent = ''; return; }
  const t = v.currentTime - S.subDelay;
  const c = S.cues.find(c => t >= c.a && t <= c.b);
  const html = c ? esc(c.text).replace(/\n/g, '<br>') : '';
  if (el.innerHTML !== html) el.innerHTML = html;
}

/* --------------------------------------------------------------- bookmarks */

function renderMarks() {
  const d = v.duration || S.list[S.cur]?.dur || 0;
  $('#mk').innerHTML = S.marks
    .map(t => `<i style="left:${d ? (t / d) * 100 : 0}%"></i>`).join('');
  $('#ml').innerHTML = S.marks.length
    ? S.marks.map((t, i) =>
        `<button class="b" data-jump="${i}" style="margin:0 6px 6px 0">${fmt(t)}</button>` +
        `<button class="b danger" data-unmark="${i}" style="margin:0 6px 6px -3px">✕</button>`
      ).join('')
    : '<small>No bookmarks yet — press E while playing.</small>';
}
function drawMarks(d) {
  const marks = $('#mk').children;
  if (marks.length !== S.marks.length) { renderMarks(); return; }
  for (let i = 0; i < marks.length; i++)
    marks[i].style.left = (d ? (S.marks[i] / d) * 100 : 0) + '%';
}

/* ---------------------------------------------------------------- seek bar */

const sk = $('#sk');
let skDrag = false;
function seekFromEvent(e) {
  const r = sk.getBoundingClientRect();
  const f = clamp((e.clientX - r.left) / r.width, 0, 1);
  const d = v.duration || S.list[S.cur]?.dur || 0;
  if (d) v.currentTime = f * d;
  return { f, d };
}
sk.addEventListener('pointerdown', e => {
  if (!S.hasSrc && !v.duration) return;
  skDrag = true; sk.classList.add('drag'); sk.setPointerCapture(e.pointerId);
  seekFromEvent(e); wake();
});
sk.addEventListener('pointermove', e => {
  if (skDrag) seekFromEvent(e);
  else if (e.pointerType === 'mouse') hoverTip(e);
});
sk.addEventListener('pointerup', () => { skDrag = false; sk.classList.remove('drag'); });
sk.addEventListener('pointercancel', () => { skDrag = false; sk.classList.remove('drag'); });
sk.addEventListener('pointerleave', () => { $('#tip').style.display = ''; });

const pv = document.createElement('video');
pv.muted = true; pv.preload = 'auto'; pv.crossOrigin = 'anonymous';

const hoverTip = throttle(e => {
  if (!S.hasSrc) return;
  const d = v.duration || 0;
  if (!d) return;
  const r = sk.getBoundingClientRect();
  const f = clamp((e.clientX - r.left) / r.width, 0, 1);
  const tip = $('#tip');
  tip.style.left = clamp(f * r.width, 60, r.width - 60) + 'px';
  tip.querySelector('b').textContent = fmt(f * d);
  tip.style.display = 'block';
  previewDraw(f * d, $('#pc'));
}, 180);

let pvBusy = false, pvWanted = null, pvSrc = '', pvTimer = 0;
function previewDraw(ts, canvas) {
  if (pvBusy) { pvWanted = ts; return; }
  const it = S.list[S.cur];
  if (!it) return;
  if (it.tier === 2) {
    pvBusy = true;
    engine.drawPreview(ts, canvas).finally(() => {
      pvBusy = false;
      if (pvWanted != null) { const t = pvWanted; pvWanted = null; previewDraw(t, canvas); }
    });
    return;
  }
  const src = it.convertedURL || it.url;
  if (!src) return;
  pvBusy = true;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(pvTimer);
    pv.removeEventListener('seeked', onSeeked);
    pvBusy = false;
    if (pvWanted != null) { const t = pvWanted; pvWanted = null; previewDraw(t, canvas); }
  };
  const onSeeked = () => {
    try { canvas.getContext('2d').drawImage(pv, 0, 0, canvas.width, canvas.height); } catch {}
    done();
  };
  pv.addEventListener('seeked', onSeeked);
  pvTimer = setTimeout(done, 2500);   // CORS / no-frame safety
  const go = () => { try { pv.currentTime = ts; } catch { done(); } };
  if (pvSrc !== src) { pvSrc = src; pv.src = src; }
  if (pv.readyState >= 1) go();
  else pv.addEventListener('loadedmetadata', go, { once: true });
}
pv.addEventListener('error', () => { pvSrc = ''; });

/* ------------------------------------------------------------------ actions */

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const ASPECTS = ['Fit', 'Fill', '16:9', '4:3', '1:1'];

function cycle(arr, cur, d) {
  const i = arr.indexOf(cur);
  return arr[(i + d + arr.length) % arr.length];
}

const ACT = {
  open: () => $('#fi').click(),
  folder: () => $('#fo').click(),
  url: () => {
    const u = prompt('Media URL (mp4 / m3u8 / mkv / mp3 …)');
    if (u) add([{ name: u.split('/').pop()?.split('?')[0] || 'remote media', url: u }]);
  },
  play: () => {
    if (S.loading) return;
    if (!S.list.length) { ACT.open(); return; }
    if (!S.hasSrc) { load(S.cur < 0 ? 0 : S.cur); return; }
    v.paused ? v.play().catch(() => {}) : v.pause();
  },
  prev,
  next: () => next(false),
  mute: () => setMuted(!S.muted),
  speed: (d = 1) => {
    S.rate = cycle(SPEEDS, S.rate, d);
    v.playbackRate = S.rate;
    $('#bSp .spd').textContent = S.rate + '×';
    osd('Speed ' + S.rate + '×');
    updateMenu();
  },
  aspect: () => {
    S.aspect = cycle(ASPECTS, S.aspect, 1);
    $('#bAs').textContent = S.aspect;
    osd('Aspect: ' + S.aspect);
    layout(); updateMenu();
  },
  ab: () => {
    const t = v.currentTime;
    if (!S.ab) { S.ab = { a: t, b: null }; osd('A set at ' + fmt(t)); }
    else if (S.ab.b == null) {
      if (t <= S.ab.a + 0.5) { S.ab = null; osd('A–B cleared'); }
      else { S.ab.b = t; osd('B set — looping ' + fmt(S.ab.a) + ' → ' + fmt(t)); }
    } else { S.ab = null; $('#ab').style.width = '0'; osd('A–B cleared'); }
    $('#bAB').classList.toggle('on', !!S.ab);
    updateMenu();
  },
  shuf: () => {
    S.shuf = !S.shuf;
    osd('Shuffle ' + (S.shuf ? 'on' : 'off'));
    updateQueueButtons(); updateMenu();
  },
  rep: () => {
    S.rep = (S.rep + 1) % 3;
    const lbl = ['off', 'all', 'one'][S.rep];
    $('#bRep').querySelector('span').textContent = 'Repeat: ' + lbl;
    $('#bRep').classList.toggle('on', S.rep > 0);
    osd('Repeat ' + lbl);
    updateQueueButtons(); updateMenu();
  },
  sort: () => {
    const cur = S.list[S.cur];
    S.list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    S.cur = cur ? Math.max(0, S.list.indexOf(cur)) : -1;
    renderQ(); osd('Sorted A→Z');
  },
  clear: () => {
    S.list.forEach(it => {
      it.dead = true;
      if (it.convertedURL) URL.revokeObjectURL(it.convertedURL);
      if (it.url) URL.revokeObjectURL(it.url);
    });
    S.list = []; S.cur = -1; S.cues = null;
    stopPlayback(); hideLoad();
    $('#badge').classList.remove('on');
    renderQ(); updateInfo();
  },
  cc: () => {
    S.sOn = !S.sOn;
    $('#bCC').classList.toggle('on', S.sOn);
    $('#bCC2').textContent = S.sOn ? 'Hide subtitles' : 'Show subtitles';
    osd('Subtitles ' + (S.sOn ? 'on' : 'off'));
  },
  subload: () => $('#fsub').click(),
  sdm: () => { S.subDelay = clamp(S.subDelay - 0.1, -5, 5); $('#sdv').textContent = S.subDelay.toFixed(1) + 's'; },
  sdp: () => { S.subDelay = clamp(S.subDelay + 0.1, -5, 5); $('#sdv').textContent = S.subDelay.toFixed(1) + 's'; },
  rotl: () => { S.rot = (S.rot - 90) % 360; layout(); osd('Rotate −90°'); },
  rotr: () => { S.rot = (S.rot + 90) % 360; layout(); osd('Rotate +90°'); },
  flip: () => { S.flipX *= -1; layout(); osd('Flipped'); },
  reset: () => {
    S.f = { b: 100, c: 100, s: 100, h: 0 }; S.rot = 0; S.flipX = 1; S.zoom = 1;
    $('#fb').value = 100; $('#fc').value = 100; $('#fs').value = 100;
    $('#fh').value = 0; $('#fz').value = 100;
    syncFilterLabels(); applyFilters(); layout(); osd('Picture reset');
  },
  mark: () => {
    const t = v.currentTime;
    S.marks.push(t); S.marks.sort((a, b) => a - b);
    renderMarks(); osd('Bookmarked ' + fmt(t));
  },
  snap: () => {
    if (!S.hasSrc) return osd('Nothing playing');
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob(b => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = `reel-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        osd('Screenshot saved');
      });
    } catch { osd('Screenshot blocked (protected stream)'); }
  },
  pip: async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { osd('PiP unavailable'); }
  },
  fs: async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('#stage').requestFullscreen();
    } catch { osd('Fullscreen unavailable'); }
  },
  theater: () => {
    app.classList.toggle('th');
    $('#bTh').classList.toggle('on', app.classList.contains('th'));
    layout();
  },
  stats: () => {
    S.stats = !S.stats;
    $('#stats').style.display = S.stats ? 'block' : 'none';
    $('#bStats').classList.toggle('on', S.stats);
    if (S.stats) drawStats();
  },
  gear: () => toggleMenu(),
  viz: () => { S.viz = !S.viz; $('#mViz').classList.toggle('on', S.viz); if (!S.viz) $('#viz').style.display = 'none'; osd('Visualizer ' + (S.viz ? 'on' : 'off')); },
  help: () => $('#help').classList.toggle('on'),
  info: () => {
    if (!matchMedia('(max-width:900px)').matches && app.classList.contains('hideside')) {
      app.classList.remove('hideside');
      $('#bSide').classList.remove('on');
      setTimeout(layout, 30);
    }
    tab('info'); openPanel();
  },
  side: () => {
    if (matchMedia('(max-width:900px)').matches) toggleDrawer();
    else { app.classList.toggle('hideside'); $('#bSide').classList.toggle('on', !app.classList.contains('hideside')); setTimeout(layout, 30); }
  },
};

document.addEventListener('click', e => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab(tabBtn.dataset.tab); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) { e.stopPropagation(); rmItem(+rm.dataset.rm); return; }
  const jump = e.target.closest('[data-jump]');
  if (jump) {
    const t = S.marks[+jump.dataset.jump];
    if (t != null && S.hasSrc) { v.currentTime = t; osd('→ ' + fmt(t)); }
    return;
  }
  const un = e.target.closest('[data-unmark]');
  if (un) { S.marks.splice(+un.dataset.unmark, 1); renderMarks(); return; }
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.id === 'bigPlay') { ACT.play(); return; }
  if (btn.id === 'bDrawer') { toggleDrawer(); return; }
  const a = btn.dataset.a;
  if (!a || !ACT[a]) return;
  ACT[a]();
  audioInit(); ac?.resume?.().catch(() => {});
  if (btn.closest('#menu')) {
    updateMenu();
    if (!['speed', 'aspect', 'ab', 'shuf', 'rep'].includes(a)) closeMenu();
  }
});

function rmItem(i) {
  const it = S.list[i];
  if (!it) return;
  it.dead = true;
  if (it.convertedURL) URL.revokeObjectURL(it.convertedURL);
  URL.revokeObjectURL(it.url);
  S.list.splice(i, 1);
  if (i === S.cur) {
    stopPlayback();
    if (S.list.length) load(Math.min(i, S.list.length - 1));
    else { S.cur = -1; $('#badge').classList.remove('on'); }
  } else if (i < S.cur) S.cur--;
  renderQ();
}

/* --------------------------------------------------------------- queue drag */

let dragI = -1;
const qEl = $('#q');
qEl.addEventListener('click', e => {
  if (e.target.closest('[data-rm]')) return;
  const item = e.target.closest('.qit');
  if (!item) return;
  const i = +item.dataset.i;
  if (i === S.cur) { ACT.play(); return; }
  load(i);
});
qEl.addEventListener('dragstart', e => {
  const item = e.target.closest('.qit');
  if (!item) return;
  dragI = +item.dataset.i;
  item.classList.add('drag');
  e.dataTransfer.effectAllowed = 'move';
});
qEl.addEventListener('dragend', () => {
  dragI = -1;
  $$('.qit').forEach(x => x.classList.remove('drag', 'over'));
});
qEl.addEventListener('dragover', e => {
  e.preventDefault();
  const item = e.target.closest('.qit');
  $$('.qit').forEach(x => x.classList.toggle('over', x === item));
});
qEl.addEventListener('drop', e => {
  e.preventDefault();
  const item = e.target.closest('.qit');
  $$('.qit').forEach(x => x.classList.remove('over'));
  if (!item || dragI < 0) return;
  let to = +item.dataset.i;
  const cur = S.list[S.cur];
  const [moved] = S.list.splice(dragI, 1);
  if (dragI < to) to--;
  S.list.splice(to, 0, moved);
  S.cur = cur ? Math.max(0, S.list.indexOf(cur)) : -1;
  renderQ();
});

/* ------------------------------------------------------------------- inputs */

$('#fi').addEventListener('change', e => {
  add([...e.target.files].map(f => ({ name: f.name, f })));
  e.target.value = '';
});
$('#fo').addEventListener('change', e => {
  add([...e.target.files].filter(f => !f.name.startsWith('.')).map(f => ({ name: f.name, f })));
  e.target.value = '';
});
$('#fsub').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) readSubFile({ f, name: f.name });
  e.target.value = '';
});
$('#vol').addEventListener('input', e => setVol(e.target.value / 100, { silent: true }));
$('#vol2').addEventListener('input', e => setVol(e.target.value / 100, { silent: true }));

function syncFilterLabels() {
  $('#fb').nextElementSibling.textContent = $('#fb').value;
  $('#fc').nextElementSibling.textContent = $('#fc').value;
  $('#fs').nextElementSibling.textContent = $('#fs').value;
  $('#fh').nextElementSibling.textContent = $('#fh').value;
  $('#fz').nextElementSibling.textContent = $('#fz').value;
}
function applyFilters() {
  v.style.filter =
    `brightness(${S.f.b}%) contrast(${S.f.c}%) saturate(${S.f.s}%) hue-rotate(${S.f.h}deg)`;
}
$$('.fl').forEach(inp => inp.addEventListener('input', () => {
  S.f = { b: +$('#fb').value, c: +$('#fc').value, s: +$('#fs').value, h: +$('#fh').value };
  syncFilterLabels(); applyFilters();
}));
$('#fz').addEventListener('input', () => { S.zoom = +$('#fz').value / 100; layout(); });
$('#ssz').addEventListener('input', e => {
  document.documentElement.style.setProperty('--fs', e.target.value + 'px');
  e.target.nextElementSibling.textContent = e.target.value + 'px';
});

/* --------------------------------------------------------------- layout/pic */

function layout() {
  const r = wrap.getBoundingClientRect();
  if (!r.width) return;
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const rotQ = ((S.rot % 180) + 180) % 180 === 90;
  let w, h;
  if (S.aspect === 'Fill') {
    w = r.width; h = r.height; v.style.objectFit = 'fill';
  } else {
    v.style.objectFit = 'contain';
    let ar = vw / vh;
    if (S.aspect === '16:9') ar = 16 / 9;
    else if (S.aspect === '4:3') ar = 4 / 3;
    else if (S.aspect === '1:1') ar = 1;
    if (!Number.isFinite(ar) || ar <= 0) ar = 16 / 9;
    // element keeps content AR; after 90° rotation visual AR flips automatically
    const scale = rotQ ? Math.min(r.width, r.height / ar) : Math.min(r.width / ar, r.height);
    w = scale * ar; h = scale;
  }
  v.style.width = Math.round(w) + 'px';
  v.style.height = Math.round(h) + 'px';
  v.style.transform = `rotate(${S.rot}deg) scale(${S.zoom * S.flipX}, ${S.zoom})`;
}
new ResizeObserver(() => layout()).observe($('#stage'));

/* --------------------------------------------------------------------- EQ */

function buildEQ() {
  $('#pre').innerHTML = Object.keys(EQ_PRESETS).map(k => `<option>${k}</option>`).join('');
  $('#eqs').innerHTML = EQ_HZ.map((hz, i) => `
    <label><input type="range" class="eq" data-i="${i}" min="-12" max="12" step="1" value="0">
    <small>${hz >= 1000 ? hz / 1000 + 'k' : hz}</small></label>`).join('');
  $('#pre').addEventListener('change', e => {
    eqGains = [...EQ_PRESETS[e.target.value]];
    $('#eqs').querySelectorAll('input').forEach((inp, i) => { inp.value = eqGains[i]; });
    applyEQ(); osd('EQ: ' + e.target.value);
  });
  $('#eqs').addEventListener('input', e => {
    if (!e.target.matches('input')) return;
    eqGains[+e.target.dataset.i] = +e.target.value;
    $('#pre').value = 'Flat';
    applyEQ();
  });
}
function applyEQ() {
  filters.forEach((f, i) => { if (f) f.gain.value = eqGains[i]; });
}

/* -------------------------------------------------------------- audio tracks */

function renderAudioTracks(it) {
  const box = $('#atracks');
  const tracks = it?.tier === 2 ? (it.info?.audioTracks || []) : [];
  if (tracks.length < 2) { box.innerHTML = it?.tier === 2 ? '<small>Single audio track</small>' : ''; return; }
  box.innerHTML = `<div class="f" style="grid-template-columns:92px 1fr">
    <span>Track</span>
    <select id="atrack">${tracks.map(t =>
      `<option value="${t.index}" ${t.index === (it.info?.audioIndex ?? 0) ? 'selected' : ''}>
        ${esc(t.name || t.language || 'Track ' + (t.index + 1))} · ${shortCodec(t.codec)}</option>`).join('')}</select></div>`;
  $('#atrack').addEventListener('change', e => {
    const i = S.cur;
    const item = S.list[i];
    if (!item) return;
    item.ai = +e.target.value;
    item.attempt = item.attempts.findIndex(a => a.tier === 2 && !a.noAudio);
    if (item.attempt < 0) item.attempt = 0;
    load(i, true);
  });
}

/* ------------------------------------------------------------------- info */

function updateInfo() {
  if (!$('#p-info').classList.contains('on')) return;
  const it = S.list[S.cur];
  const rows = [];
  const add2 = (k, val) => { if (val) rows.push(`<div class="kv"><span>${k}</span><b>${val}</b></div>`); };
  add2('File', it ? esc(it.name) : '—');
  add2('Size', it?.f ? (it.f.size / 1048576).toFixed(1) + ' MB' : '');
  add2('Duration', it?.dur ? fmt(it.dur) : (v.duration ? fmt(v.duration) : ''));
  add2('Container', it ? extOf(it.name).toUpperCase() : '');
  add2('Engine', it?.tier ? `Tier ${it.tier} — ${TIER_LABEL[{ 1: 1, 2: 2, 3: 3 }[it.tier]]}` : '');
  if (it?.tier === 2 && it.info) {
    add2('Video', `${shortCodec(it.info.videoCodec)} · ${it.info.videoParam || ''}`);
    add2('Audio', it.info.audioDisabled ? 'disabled'
      : `${shortCodec(it.info.audioCodec)}${it.info.audioTranscoded ? ' → AAC (in-browser)' : ''}`);
    add2('Segments', it.info.segments);
    add2('Audio tracks', (it.info.audioTracks || []).length);
  } else if (it?.probe?.readable) {
    add2('Video', shortCodec(it.probe.videoCodec) + (it.probe.width ? ` · ${it.probe.width}×${it.probe.height}` : ''));
    add2('Audio', shortCodec(it.probe.audioCodec));
  }
  if (it?.tier === 3) {
    add2('Method', { remux: 'stream copy', x264: 'H.264 + AAC', mpeg4: 'MPEG-4 + AAC' }[it.mode] || it.mode);
    add2('Converted', it.convertedBlob ? (it.convertedBlob.size / 1048576).toFixed(1) + ' MB' : '');
  }
  if (v.videoWidth) add2('Playing at', `${v.videoWidth}×${v.videoHeight}`);
  try { if (v.buffered.length) add2('Buffered', (v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(1) + ' s'); } catch {}
  add2('Queue', S.list.length + ' items');
  add2('Resume', it ? fmt(+(localStorage.getItem(resumeKey(it)) || 0)) : '');
  $('#kl').innerHTML = rows.join('') ||
    '<div class="kv"><span>No media loaded</span><b>—</b></div>';
}
function tab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.pn').forEach(p => p.classList.toggle('on', p.id === 'p-' + name));
  if (name === 'info') updateInfo();
}

/* ------------------------------------------------------------------ stats */

function drawStats() {
  const it = S.list[S.cur];
  const q = v.getVideoPlaybackQuality?.();
  const lines = [
    `${v.videoWidth || 0}×${v.videoHeight || 0} · ${S.rate}× · vol ${Math.round(S.vol * 100)}%`,
    `V ${shortCodec(it?.probe?.videoCodec) || (it?.tier === 2 ? it.info?.videoCodec : '') || '—'}   A ${it?.noAudio ? 'off' : shortCodec(it?.probe?.audioCodec) || (it?.tier === 2 ? it.info?.audioCodec : '') || '—'}`,
    `buf ${(v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0).toFixed(1)}s  dropped ${q?.droppedVideoFrames ?? '—'}`,
    `engine ${it?.tier ? SHORT_TIER[it.tier] : '—'}${it?.tier === 2 ? ' · ' + (it.info?.segments || 0) + ' segs' : ''}${it?.tier === 3 ? ' · ' + it.mode : ''}`,
    `t ${fmt(v.currentTime)} / ${fmt(v.duration || 0)}`,
  ];
  $('#stats').textContent = lines.join('\n');
}

/* ------------------------------------------------------------------ mediaSession */

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const it = S.list[S.cur];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it?.name || 'Reel', artist: '', album: 'Reel queue',
    });
    navigator.mediaSession.setActionHandler('play', () => v.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => v.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null) v.currentTime = d.seekTime; });
  } catch {}
}

/* --------------------------------------------------------------------- menu */

function toggleMenu() {
  S.menuOpen ? closeMenu() : openMenu();
}
function openMenu() {
  S.menuOpen = true;
  $('#menu').classList.add('on');
  $('#scrim').classList.add('on');
  updateMenu();
}
function closeMenu() {
  S.menuOpen = false;
  $('#menu').classList.remove('on');
  if (!$('#side').classList.contains('open')) $('#scrim').classList.remove('on');
}
function updateMenu() {
  $('#mSp').textContent = S.rate + '×';
  $('#mAs').textContent = S.aspect;
  $('#mAb').textContent = S.ab ? (S.ab.b != null ? 'looping' : 'A set') : 'off';
  $('#mSh').textContent = S.shuf ? 'on' : 'off';
  $('#mRep').textContent = ['off', 'all', 'one'][S.rep];
  $('#mViz').classList.toggle('on', S.viz);
}
function toggleDrawer() {
  const side = $('#side');
  const open = side.classList.toggle('open');
  $('#scrim').classList.toggle('on', open || S.menuOpen);
}
function closeDrawer() {
  $('#side').classList.remove('open');
  if (!S.menuOpen) $('#scrim').classList.remove('on');
}
function openPanel() {
  if (matchMedia('(max-width:900px)').matches && !$('#side').classList.contains('open')) toggleDrawer();
}
$('#scrim').addEventListener('click', () => { closeMenu(); closeDrawer(); });
$('#help').addEventListener('click', e => { if (e.target === $('#help')) $('#help').classList.remove('on'); });

/* ----------------------------------------------------------------- gestures */

const pts = new Map();
let G = null, tapTimer = null, lastTap = 0, lpTimer = null;
let boosting = false;

wrap.addEventListener('pointerdown', e => {
  if (e.target.closest('#ctl,#empty,#load,#bigPlay')) { wake(); return; }
  if (e.button != null && e.button !== 0) return;
  audioInit(); ac?.resume?.().catch(() => {});
  const wasIdle = app.classList.contains('idle');
  wake();
  wrap.setPointerCapture?.(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) {
    cancelTap();
    const [a, b] = [...pts.values()];
    G = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: S.zoom };
    v.style.transition = 'none';
    return;
  }
  const r = wrap.getBoundingClientRect();
  G = {
    id: e.pointerId, mode: null, moved: false,
    x0: e.clientX, y0: e.clientY, t0: v.currentTime,
    zoneL: (e.clientX - r.left) < r.width / 2,
    ptrType: e.pointerType,
    b0: S.f.b, v0: S.vol,
    rect: r, wasIdle,
  };
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    if (G && !G.moved && pts.size === 1 && !v.paused && v.readyState >= 2) {
      G.mode = 'lp';
      boosting = true;
      v.playbackRate = 2;
      osd('2× speed (hold)');
    }
  }, 550);
}, { passive: true });

wrap.addEventListener('pointermove', e => {
  if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!G) return;
  if (G.mode === 'pinch') {
    if (pts.size < 2) return;
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    S.zoom = clamp(G.z0 * (d / (G.d0 || 1)), 0.5, 3);
    $('#fz').value = Math.round(S.zoom * 100);
    $('#fz').nextElementSibling.textContent = $('#fz').value;
    layout();
    return;
  }
  if (G.id !== e.pointerId) return;
  const dx = e.clientX - G.x0, dy = e.clientY - G.y0;
  if (!G.moved && Math.hypot(dx, dy) > 10) {
    G.moved = true;
    clearTimeout(lpTimer);
    if (G.mode === 'lp') restoreRate();
    if (G.mode == null) {
      if (Math.abs(dx) > Math.abs(dy) * 1.2 && (v.duration || S.hasSrc)) G.mode = 'seek';
      else if (e.pointerType === 'touch') G.mode = G.zoneL ? 'bright' : 'vol';
      else G.mode = 'ignore';
      if (G.mode === 'seek') showSeekBubble(e);
      else if (G.mode === 'bright') $('#gbL').classList.add('on');
      else if (G.mode === 'vol') $('#gbR').classList.add('on');
    }
  }
  if (G.mode === 'seek') moveSeekBubble(e, dx);
  else if (G.mode === 'bright') {
    const val = clamp(G.b0 - dy * 0.55, 0, 200);
    $('#fb').value = Math.round(val);
    S.f.b = val; syncFilterLabels(); applyFilters();
    const g = $('#gbL');
    g.querySelector('i').style.setProperty('--p', (val / 2) + '%');
    g.querySelector('span').textContent = Math.round(val) + '%';
  } else if (G.mode === 'vol') {
    setVol(G.v0 - dy * 0.006, { silent: true });
    const g = $('#gbR');
    g.querySelector('i').style.setProperty('--p', (S.vol / 2) * 100 + '%');
    g.querySelector('span').textContent = Math.round(S.vol * 100) + '%';
  }
}, { passive: true });

function restoreRate() {
  if (!boosting) return;
  boosting = false;
  v.playbackRate = S.rate;
  if (S.rate !== 1) osd(S.rate + '× speed');
}
wrap.addEventListener('pointerup', onPointerEnd);
wrap.addEventListener('pointercancel', onPointerEnd);
function onPointerEnd(e) {
  pts.delete(e.pointerId);
  clearTimeout(lpTimer);
  if (!G) return;
  if (G.mode === 'pinch') {
    if (pts.size === 0) { G = null; v.style.transition = ''; $('#fz').value = Math.round(S.zoom * 100); $('#fz').nextElementSibling.textContent = $('#fz').value; }
    return;
  }
  if (G.id !== e.pointerId) return;
  const g = G;
  G = null;
  if (g.mode === 'lp') { restoreRate(); return; }
  if (g.mode === 'seek') { finishSeekBubble(); return; }
  if (g.mode === 'bright') { $('#gbL').classList.remove('on'); return; }
  if (g.mode === 'vol') {
    $('#gbR').classList.remove('on');
    osd('Volume ' + Math.round(S.vol * 100) + '%');
    return;
  }
  if (g.moved) return;
  // tap handling
  const now = Date.now();
  const isDouble = now - lastTap < 300;
  lastTap = isDouble ? 0 : now;
  if (isDouble) { handleDoubleTap(e.clientX); return; }
  cancelTap();
  tapTimer = setTimeout(() => {
    tapTimer = null;
    if (g.wasIdle) wake();          // tap woke the controls — keep them
    else if (S.hasSrc) app.classList.add('idle');
    else wake();
  }, 310);
}
function cancelTap() { clearTimeout(tapTimer); tapTimer = null; }
function handleDoubleTap(cx) {
  cancelTap();
  const r = wrap.getBoundingClientRect();
  const f = (cx - r.left) / r.width;
  if (f < 0.33) { dtPop('#dtL'); seekBy(-10); }
  else if (f > 0.67) { dtPop('#dtR'); seekBy(10); }
  else ACT.fs();
}
function dtPop(sel) {
  const el = $(sel);
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 460);
}
function seekBy(d) {
  if (!S.hasSrc) return;
  v.currentTime = clamp(v.currentTime + d, 0, v.duration || 1e9);
  osd((d > 0 ? '+' : '') + d + 's → ' + fmt(v.currentTime));
}

/* seek bubble (gesture) */
function showSeekBubble(e) {
  const b = $('#gbS');
  b.classList.add('on');
  moveSeekBubble(e, 0);
}
function moveSeekBubble(e, dx) {
  if (!G) return;
  const d = v.duration || S.list[S.cur]?.dur || 0;
  const target = clamp(G.t0 + (dx / G.rect.width) * d, 0, d);
  const b = $('#gbS');
  const x = clamp(G.rect.width / 2 + dx, 70, G.rect.width - 70);
  b.style.left = x + 'px';
  b.querySelector('span').textContent = fmt(target) + ' / ' + fmt(d);
  if (!G.seekT || Date.now() - G.seekT > 250) {
    G.seekT = Date.now();
    if (S.hasSrc) { try { v.currentTime = target; } catch {} }
    previewDraw(target, b.querySelector('canvas'));
  }
}
function finishSeekBubble() {
  $('#gbS').classList.remove('on');
}

/* wheel volume (desktop) */
wrap.addEventListener('wheel', e => {
  e.preventDefault();
  setVol(S.vol + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });

/* ------------------------------------------------------------------- idle */

let idleT;
function wake() {
  app.classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    if (!v.paused && !S.menuOpen && !$('#help').classList.contains('on') && !$('#load').classList.contains('on')) {
      if ($('#ctl').matches(':hover')) { wake(); return; }
      app.classList.add('idle');
    }
  }, 2600);
}
['pointermove', 'pointerdown', 'keydown'].forEach(ev =>
  window.addEventListener(ev, () => { if (app.classList.contains('idle')) wake(); }, { passive: true }));

/* -------------------------------------------------------------- fullscreen */

function syncFsIcons() {
  const on = !!document.fullscreenElement;
  $('#bFsTop use').setAttribute('href', on ? '#i-min' : '#i-max');
  $$('.deck [data-a="fs"] use').forEach(u => u.setAttribute('href', on ? '#i-min' : '#i-max'));
  layout();
}
document.addEventListener('fullscreenchange', syncFsIcons);

/* ----------------------------------------------------------------- drop */

let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault(); dragDepth++;
  $('#drop').classList.add('on');
});
window.addEventListener('dragover', e => { if (dragDepth) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('on'); } });
window.addEventListener('drop', e => {
  if (!dragDepth) return;
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) add(files.map(f => ({ name: f.name, f })));
});

/* ----------------------------------------------------------------- keys */

const KEYS = [
  ['Space / K', 'Play · pause'],
  ['J / L', 'Back · forward 10 s'],
  ['← / →', 'Seek 5 s (Shift: 30 s)'],
  ['↑ / ↓', 'Volume ±5%'],
  ['N / P', 'Next · previous'],
  ['F', 'Fullscreen'],
  ['T', 'Theater mode'],
  ['M', 'Mute'],
  ['[ / ]', 'Speed down · up'],
  ['C', 'Subtitles on / off'],
  ['A', 'A–B loop'],
  ['E', 'Bookmark current time'],
  ['S', 'Screenshot'],
  ['I', 'Picture in picture'],
  ['V', 'Aspect ratio'],
  ['Y', 'Playback stats'],
  ['X', 'Shuffle'],
  ['R', 'Repeat mode'],
  [', / .', 'Frame step back · forward'],
  ['O / U', 'Open files / URL'],
  ['? / H', 'This list'],
  ['0 – 9', 'Seek 0% … 90%'],
];
function buildHelp() {
  $('#kl2').innerHTML = KEYS.map(([k, d]) =>
    `<div class="kv"><span>${d}</span><kbd>${k}</kbd></div>`).join('');
}

window.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.matches('input,select,textarea') || t.isContentEditable)) return;
  const k = e.key;
  if (k === ' ' && t?.tagName === 'BUTTON') return;   // let the button's own click win
  if (k === 'Escape') {
    if ($('#help').classList.contains('on')) { $('#help').classList.remove('on'); return; }
    if (S.menuOpen) { closeMenu(); return; }
    if ($('#side').classList.contains('open')) { closeDrawer(); return; }
    if (document.fullscreenElement) document.exitFullscreen();
    return;
  }
  if (k === '?' || k === 'h' || k === 'H') { ACT.help(); return; }
  const step = e.shiftKey ? 30 : 5;
  switch (k) {
    case ' ': case 'k': case 'K': e.preventDefault(); ACT.play(); break;
    case 'j': case 'J': seekBy(-10); break;
    case 'l': case 'L': seekBy(10); break;
    case 'ArrowLeft': e.preventDefault(); seekBy(-step); break;
    case 'ArrowRight': e.preventDefault(); seekBy(step); break;
    case 'ArrowUp': e.preventDefault(); setVol(S.vol + 0.05); break;
    case 'ArrowDown': e.preventDefault(); setVol(S.vol - 0.05); break;
    case 'n': case 'N': next(false); break;
    case 'p': case 'P': prev(); break;
    case 'f': case 'F': ACT.fs(); break;
    case 't': case 'T': ACT.theater(); break;
    case 'm': case 'M': ACT.mute(); break;
    case 'c': case 'C': ACT.cc(); break;
    case 'a': case 'A': ACT.ab(); break;
    case 'e': case 'E': ACT.mark(); break;
    case 's': case 'S': ACT.snap(); break;
    case 'i': case 'I': ACT.pip(); break;
    case 'v': case 'V': ACT.aspect(); break;
    case 'y': case 'Y': ACT.stats(); break;
    case 'x': case 'X': ACT.shuf(); break;
    case 'r': case 'R': ACT.rep(); break;
    case 'o': case 'O': ACT.open(); break;
    case 'u': case 'U': ACT.url(); break;
    case '[': ACT.speed(-1); break;
    case ']': ACT.speed(1); break;
    case ',': frameStep(-1); break;
    case '.': frameStep(1); break;
    default:
      if (/^[0-9]$/.test(k) && S.hasSrc) {
        const d = v.duration || 0;
        if (d) v.currentTime = d * (+k / 10);
        osd(k === '0' ? '0%' : k + '0%');
      }
  }
});
function frameStep(dir) {
  if (!S.hasSrc) return;
  v.pause();
  const fps = 1 / 24;
  v.currentTime = clamp(v.currentTime + dir * fps, 0, v.duration || 1e9);
  osd(dir > 0 ? 'Frame +1' : 'Frame −1');
}

/* ----------------------------------------------------------------- play icon */

function syncPlayIcon() {
  $('#bPlay use').setAttribute('href', v.paused ? '#i-play' : '#i-pause');
}

/* ----------------------------------------------------------------- init */

function updateQueueButtons() {
  $('#bShuf').classList.toggle('on', S.shuf);
}

function init() {
  buildHelp();
  buildEQ();
  syncVolUI();
  syncPlayIcon();
  syncFilterLabels();
  $('#bCC').classList.add('on');
  $('#bCC2').textContent = 'Hide subtitles';
  $('#sdv').textContent = '0s';
  $('#ssz').nextElementSibling.textContent = '26px';
  $('#bSide').classList.add('on');
  updateQueueButtons();
  updateMenu();
  renderQ();
  layout();
  wake();
  updateMediaSession();
  vizLoop();
  setInterval(() => { if (S.cur >= 0) updateMediaSession(); if ($('#p-info').classList.contains('on')) updateInfo(); }, Math.max(10000, 1000));
}
init();

window.addEventListener('beforeunload', () => {
  const it = S.list[S.cur];
  if (it && v.currentTime > 0) {
    try { localStorage.setItem(resumeKey(it), String(v.currentTime)); } catch {}
  }
  shutdownEngine();
});

console.info('%c[reel] ready — 3-tier engine (native → remux → ffmpeg)', 'color:#7aa2ff');
