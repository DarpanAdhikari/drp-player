/**
 * Reel format engine — tiered client-side playback.
 *
 *   Tier 1: native <video> playback (mp4/webm/mov/audio…)
 *   Tier 2: lossless remux → fMP4 → hls.js / MediaSource
 *           (mediabunny demux/mux — works for .mkv .ts .mka …)
 *   Tier 3: ffmpeg.wasm remux/transcode → native playback
 *           (.avi .wmv .flv, codecs no browser can decode)
 *
 * Segment planning, fMP4 muxing and hls.js loader glue follow the architecture
 * of kzahel/playsvideo (MIT) — https://github.com/kzahel/playsvideo
 * ADTS parsing and the vendored audio-only ffmpeg core (LGPL-2.1 runtime)
 * are taken from that project; the audio core converts AC3/EAC3/DTS/MP3/FLAC/Opus
 * segment audio to AAC in-browser so Matroska audio always plays.
 */
import {
  ALL_FORMATS, BlobSource, UrlSource, Input, EncodedPacketSink, EncodedPacket,
  Output, Mp4OutputFormat, NullTarget, EncodedVideoPacketSource, EncodedAudioPacketSource,
  CanvasSink,
} from 'mediabunny';
import Hls from 'hls.js/light';
import { FFmpeg } from './vendor/ffmpeg-esm/index.js';

/* ------------------------------------------------------------------ errors */

export class EngineError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'EngineError';
    this.code = code;      // container | codec | mse | network | size | audio | hls | ffmpeg | cancelled
    this.cause = cause;
  }
}

/* -------------------------------------------------- extension / tier table */

const NATIVE_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
  mkv: 'video/x-matroska', mka: 'audio/x-matroska',
  ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-wmv',
  flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  rmvb: 'application/vnd.rn-realmedia', rm: 'application/vnd.rn-realmedia',
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac',
  oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
};

// containers mediabunny can demux (tier 2 candidates)
const MB_READABLE = new Set([
  'mp4', 'm4v', 'm4a', 'mov', 'qt', 'mkv', 'mka', 'webm',
  'ts', 'mts', 'm2ts', 'ogg', 'ogv', 'oga', 'mp3', 'wav', 'wave', 'flac', 'aac', 'adts',
]);

export const extOf = name => (String(name).match(/\.([^.?#/]+)(?:[?#]|$)/)?.[1] || '').toLowerCase();

function canPlay(mime) {
  try {
    const el = document.createElement(mime.startsWith('audio/') ? 'audio' : 'video');
    return !!el.canPlayType(mime);
  } catch { return false; }
}

/** Ordered list of tiers to attempt for this file/URL. */
export function planTiers(name) {
  const ext = extOf(name);
  const mime = NATIVE_MIME[ext];
  if (!mime && !ext) return [1, 2, 3];           // extensionless — try everything
  const tiers = [];
  if (!mime || canPlay(mime)) tiers.push(1);
  if (!mime || MB_READABLE.has(ext)) tiers.push(2);
  tiers.push(3);
  return tiers;
}

export const TIER_LABEL = {
  1: 'Native playback',
  2: 'Lossless remux → MSE',
  3: 'ffmpeg conversion',
};

/* -------------------------------------------------------- media probe info */

/**
 * Cheap probe: duration + thumbnail + codec summary for any readable file.
 * Returns { readable:false } for containers mediabunny can't open (avi/wmv…).
 */
export async function probeSource(src, opts = {}) {
  const thumbAt = opts.thumbAt ?? 0.1;
  const thumbW = opts.thumbWidth ?? 160;
  const source = typeof src === 'string' ? new UrlSource(src) : new BlobSource(src);
  const input = new Input({ formats: ALL_FORMATS, source });
  try {
    if (!await input.canRead()) return { readable: false };
    let duration = await input.getDurationFromMetadata().catch(() => null);
    if (!duration) duration = await input.computeDuration().catch(() => 0);
    const vt = await input.getPrimaryVideoTrack().catch(() => null);
    const at = await input.getPrimaryAudioTrack().catch(() => null);
    const audioTracks = await input.getAudioTracks().catch(() => []);
    const audioTrackList = await Promise.all(audioTracks.map(async (t, i) => ({
      index: i, codec: t.codec,
      name: await t.getName().catch(() => null),
      language: await t.getLanguageCode().catch(() => null),
    })));
    let thumb = '', width = 0, height = 0, decodable = true;
    if (vt) {
      width = (await vt.getDisplayWidth().catch(() => 0)) || 0;
      height = (await vt.getDisplayHeight().catch(() => 0)) || 0;
      decodable = await vt.canDecode().catch(() => false);
      try {
        const first = await vt.getFirstTimestamp().catch(() => 0);
        const ts = Math.max(first, Math.min(thumbAt, (duration || 1) * 0.15));
        const sink = new CanvasSink(vt, { width: thumbW });
        const c = await sink.getCanvas(ts);
        if (c) {
          const ar = width && height ? width / height : 16 / 9;
          const cv = document.createElement('canvas');
          cv.width = thumbW; cv.height = Math.max(1, Math.round(thumbW / ar));
          cv.getContext('2d').drawImage(c.canvas, 0, 0, cv.width, cv.height);
          thumb = cv.toDataURL('image/jpeg', 0.62);
        }
      } catch { /* undecodable codec or no frame at ts */ }
    }
    return {
      readable: true, duration: duration || 0, thumb, width, height, decodable,
      videoCodec: vt?.codec ?? null, audioCodec: at?.codec ?? null,
      hasVideo: !!vt, hasAudio: !!at, audioTracks: audioTrackList,
    };
  } catch {
    return { readable: false };
  } finally {
    input.dispose();
  }
}

/**
 * Ground-truth playability check for a converted blob: hidden <video> must
 * reach 'loadedmetadata' without error. Used to verify tier-3 output.
 */
export function playableSmokeTest(blob, timeoutMs = 8000) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    v.onloadedmetadata = () => finish(true);
    v.onerror = () => finish(false);
    v.src = url;
  });
}

/* --------------------------------------------------------- subtitle probes */
/*
 * Chromium exposes neither HTMLMediaElement.audioTracks nor embedded MKV/MP4
 * subtitles via textTracks, and upstream mediabunny can't read subtitle
 * streams. For embedded subtitles we fall back to the full ffmpeg core: list
 * subtitle streams via a probe `-i` (stderr is captured through the logger),
 * then extract the selected stream to SRT text.
 */

async function ffSubtitleStreams(file) {
  const ff = await ensureFfmpeg();
  if (ffBusy) throw new EngineError('ffmpeg', 'Another conversion is already running');
  ffBusy = true;
  const ext = extOf(file.name) || 'bin';
  const inName = `sub-probe.${ext}`;
  const lines = [];
  const onLog = d => { if (d?.message) lines.push(d.message); };
  try {
    ff.on?.('log', onLog);
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    // returning code 1 is expected for probe-only runs (no output given)
    try { await ff.exec(['-hide_banner', '-loglevel', 'info', '-i', inName]); } catch {}
    const subs = [];
    let n = 0;
    for (const line of lines) {
      const m = line.match(/Stream #0:(\d+)[^:]*:\s*Subtitle:\s*(\S+)/);
      if (!m) continue;
      const lang = (line.match(/\(([^)]{2,3})\)/) || [])[1] || null;
      // -map 0:s:N uses per-type numbering, so expose that as `index`
      subs.push({ index: n++, stream: +m[1], codec: m[2], language: lang });
    }
    return subs;
  } finally {
    ff.off?.('log', onLog);
    ffBusy = false;
    try { await ff.deleteFile(inName); } catch {}
  }
}

/**
 * List embedded subtitle tracks in a local file: [{ index, codec, language }].
 * Uses the full ffmpeg core (lazy-loaded from CDN on first call).
 */
export async function listEmbeddedSubtitles(file) {
  if (file.size > FFMPEG_MAX_BYTES)
    throw new EngineError('size', 'File is too large for in-browser subtitle extraction (limit ≈1.6 GB)');
  return ffSubtitleStreams(file);
}

/**
 * Extract one embedded subtitle track to SRT text. Stream index is what ffmpeg
 * reports (see listEmbeddedSubtitles). Returns the subtitle text.
 */
export async function extractEmbeddedSubtitle(file, trackIndex) {
  const ff = await ensureFfmpeg();
  if (ffBusy) throw new EngineError('ffmpeg', 'Another conversion is already running');
  ffBusy = true;
  const ext = extOf(file.name) || 'bin';
  const inName = `sub-in.${ext}`, outName = 'sub-out.srt';
  try {
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    // forcing format via -f srt: ass/ssa/webvtt/mov_text/srt all convert to SRT
    const code = await ff.exec(['-hide_banner', '-loglevel', 'error', '-i', inName,
      '-map', `0:s:${trackIndex}`, '-f', 'srt', '-y', outName]);
    if (code !== 0)
      throw new EngineError('subtitle', 'Could not extract that subtitle track (image-based subtitles aren’t supported)');
    const data = await ff.readFile(outName);
    try { await ff.deleteFile(outName); } catch {}
    return new TextDecoder().decode(data);
  } finally {
    ffBusy = false;
    try { await ff.deleteFile(inName); } catch {}
  }
}

/* ------------------------------------------------------ codec support plan */

// Even when MSE reports AC-3/E-AC-3 support, fMP4 playback through hls.js is
// not reliably gap-free across browsers — transcode these to AAC instead.
const PIPELINE_UNSAFE_AUDIO = new Set(['ac3', 'eac3']);
// codecs the vendored audio-only ffmpeg core can decode
const AUDIO_XCODE_CODECS = new Set(['ac3', 'eac3', 'dts', 'mp3', 'flac', 'opus']);
const AUDIO_FMT = {
  ac3: 'ac3', eac3: 'eac3', dts: 'dts', mp3: 'mp3', flac: 'flac', opus: 'ogg',
};

const mseOk = mime => { try { return MediaSource.isTypeSupported(mime); } catch { return false; } };

function audioNeedsTranscode(shortCodec, param) {
  if (!param || PIPELINE_UNSAFE_AUDIO.has(shortCodec)) return true;
  return !mseOk(`audio/mp4; codecs="${param}"`);
}

/* ----------------------------------------------- segment plan (playsvideo) */
/* MIT — kzahel/playsvideo src/pipeline/segment-plan.js, lightly adapted. */

const EPS = 1 / 1000;

function normalizeBoundaries(timestamps, duration) {
  const dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) throw new EngineError('container', 'Media has no usable duration');
  const out = [...timestamps].map(Number).filter(v => Number.isFinite(v) && v >= 0 && v <= dur + EPS)
    .map(v => Math.max(0, Math.min(dur, v))).sort((a, b) => a - b);
  if (!out.length) out.unshift(0);
  const deduped = [];
  for (const v of out) if (!deduped.length || Math.abs(v - deduped[deduped.length - 1]) > EPS) deduped.push(v);
  if (dur - deduped[deduped.length - 1] > EPS) deduped.push(dur);
  else deduped[deduped.length - 1] = dur;
  if (deduped.length < 2) deduped.push(dur);
  return deduped;
}

function buildSegmentPlan({ keyframeTimestampsSec, durationSec, targetSegmentDurationSec = 4 }) {
  const dur = Number(durationSec);
  const target = Math.max(EPS, Number(targetSegmentDurationSec) || 4);
  const bounds = normalizeBoundaries(keyframeTimestampsSec, dur);
  const plan = [];
  let seq = 0, segStart = 0, nextCut = target;
  for (const b of bounds) {
    if (b < nextCut - EPS) continue;
    if (b <= segStart + EPS) continue;
    plan.push({ sequence: seq, startSec: segStart, durationSec: Math.max(EPS, b - segStart) });
    seq++; segStart = b;
    nextCut = (Math.floor((b + EPS) / target) + 1) * target;
  }
  if (dur > segStart + EPS) plan.push({ sequence: seq, startSec: segStart, durationSec: Math.max(EPS, dur - segStart) });
  if (!plan.length) plan.push({ sequence: 0, startSec: 0, durationSec: Math.max(EPS, dur) });
  return plan;
}

function generateVodPlaylist({ targetDuration, entries, mapUri = 'init.mp4' }) {
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${mapUri}"`,
  ];
  for (const e of entries) { lines.push(`#EXTINF:${e.durationSec.toFixed(6)},`); lines.push(e.uri); }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function concat(parts) {
  const total = parts.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

/* ----------------------------------------------- audio segment transcoding */
/* Vendored audio-only ffmpeg core (playsvideo → LGPL-2.1), ~1.9 MB, lazy. */

const ACORE_URL = new URL('./vendor/ffmpeg-core-audio/ffmpeg-core.js', import.meta.url).href;
const ACORE_WASM = new URL('./vendor/ffmpeg-core-audio/ffmpeg-core.wasm', import.meta.url).href;

let acoreP = null;
let audioCoreLoading = false;

async function audioCore() {
  if (acoreP) return acoreP;
  acoreP = (async () => {
    audioCoreLoading = true;
    try {
      const mod = await import(/* @vite-ignore */ ACORE_URL);
      const create = mod.default || mod.createFFmpegCore;
      if (!create) throw new EngineError('audio', 'Audio converter failed to load');
      const core = await create({
        mainScriptUrlOrBlob: `${ACORE_URL}#${btoa(JSON.stringify({ wasmURL: ACORE_WASM, workerURL: '' }))}`,
      });
      return core;
    } catch (e) {
      acoreP = null;
      throw new EngineError('audio', 'Could not load the in-browser audio converter', e);
    } finally { audioCoreLoading = false; }
  })();
  return acoreP;
}

export function audioCoreIsLoading() { return audioCoreLoading; }
export function audioCoreReady() { return !!acoreP; }

/** Preload the audio core (call during initial probing). */
export async function preloadAudioCore() { await audioCore(); }

/* ADTS parser — MIT, kzahel/playsvideo src/pipeline/adts-parse.js */
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const ADTS_CH = [0, 1, 2, 3, 4, 5, 6, 8];
function parseAdts(data) {
  const frames = [];
  let off = 0;
  while (off + 7 <= data.length) {
    if (((data[off] << 4) | (data[off + 1] >> 4)) !== 0xfff) { off++; continue; }
    const prot = data[off + 1] & 1;
    const hdr = prot ? 7 : 9;
    const size = ((data[off + 3] & 0x03) << 11) | (data[off + 4] << 3) | (data[off + 5] >> 5);
    if (size < hdr || off + size > data.length) break;
    const sri = (data[off + 2] >> 2) & 0x0f;
    const cc = ((data[off + 2] & 1) << 2) | (data[off + 3] >> 6);
    frames.push({ data: data.subarray(off, off + size), sampleRate: ADTS_RATES[sri] ?? 48000, channels: ADTS_CH[cc] ?? 2 });
    off += size;
  }
  return frames;
}

let ajob = 0;

/**
 * Transcode raw audio bytes (source codec) → AAC/ADTS packets aligned at startSec.
 * Runs synchronously on the main thread (~10–80 ms per 4 s segment).
 */
export async function transcodeAudioBytes(bytes, { codec, startSec, sampleRate = 48000 }) {
  const fmt = AUDIO_FMT[codec];
  if (!fmt) throw new EngineError('audio', `Audio codec “${codec}” can't be converted in the browser`);
  const core = await audioCore();
  const id = ++ajob;
  const iname = `reel-a${id}.${fmt}`, oname = `reel-a${id}.aac`;
  await new Promise(r => setTimeout(r, 0)); // let the UI paint before we block
  let out;
  let stderr = '';
  try {
    core.FS.writeFile(iname, bytes);
    core.setLogger(({ message }) => { stderr += message + '\n'; if (stderr.length > 4000) stderr = stderr.slice(-2000); });
    const code = core.exec('-hide_banner', '-loglevel', 'info', '-f', fmt, '-i', iname,
      '-c:a', 'aac', '-ac', '2', '-b:a', '160k', '-f', 'adts', '-y', oname);
    core.setLogger(() => {});
    core.reset();
    if (code !== 0) throw new EngineError('audio', `Audio conversion failed (${codec})`, stderr.slice(-500));
    out = core.FS.readFile(oname);
  } catch (e) {
    core.setLogger(() => {});
    try { core.reset(); } catch {}
    if (e instanceof EngineError) throw e;
    throw new EngineError('audio', `Audio conversion failed (${codec})`, e);
  } finally {
    try { core.FS.unlink(iname); } catch {}
    try { core.FS.unlink(oname); } catch {}
  }
  const frames = parseAdts(out);
  if (!frames.length) throw new EngineError('audio', 'Audio conversion produced no data');
  const packets = [];
  let ts = startSec;
  const fd = 1024 / (frames[0].sampleRate || sampleRate);
  frames.forEach((f, i) => {
    packets.push(new EncodedPacket(f.data, 'key', ts, fd, i));
    ts += fd;
  });
  return {
    packets,
    decoderConfig: {
      codec: 'mp4a.40.2',
      numberOfChannels: frames[0].channels,
      sampleRate: frames[0].sampleRate,
    },
  };
}

/* --------------------------------------------------------- fMP4 segment mux */

async function muxToFmp4({ videoPackets, audioPackets, videoCodec, audioCodec, videoDecoderConfig, audioDecoderConfig }) {
  const initParts = [];
  const pairs = [];
  let cur = [];
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: 0,
      onFtyp: d => initParts.push(new Uint8Array(d)),
      onMoov: d => initParts.push(new Uint8Array(d)),
      onMoof: d => { cur = [new Uint8Array(d)]; pairs.push(cur); },
      onMdat: d => cur.push(new Uint8Array(d)),
    }),
    target: new NullTarget(),
  });
  let vSrc = null, aSrc = null;
  if (videoCodec) { vSrc = new EncodedVideoPacketSource(videoCodec); output.addVideoTrack(vSrc); }
  if (audioCodec) { aSrc = new EncodedAudioPacketSource(audioCodec); output.addAudioTrack(aSrc); }
  await output.start();
  if (vSrc) {
    for (let i = 0; i < videoPackets.length; i++)
      await vSrc.add(videoPackets[i], i === 0 ? { decoderConfig: videoDecoderConfig } : undefined);
  }
  if (aSrc && audioPackets.length) {
    for (let i = 0; i < audioPackets.length; i++)
      await aSrc.add(audioPackets[i], i === 0 ? { decoderConfig: audioDecoderConfig } : undefined);
  }
  await output.finalize();
  return { init: concat(initParts), media: pairs.map(concat) };
}

/* ---------------------------------------------------------- packet walking */

async function collectPackets(sink, startSec, endSec, fromKey) {
  const out = [];
  if (!sink) return out;
  let p = fromKey ? await sink.getKeyPacket(startSec) : await sink.getPacket(startSec);
  if (!p) p = await sink.getFirstPacket();
  while (p) {
    if (p.timestamp >= endSec) break;
    if (!p.isMetadataOnly && p.timestamp >= 0) out.push(p);
    const next = await sink.getNextPacket(p);
    if (!next || next.sequenceNumber === p.sequenceNumber) break;
    p = next;
  }
  return out;
}

/* =========================================================== RemuxEngine */

export class RemuxEngine {
  constructor(video, opts = {}) {
    this.video = video;
    this.onPhase = opts.onPhase || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.onError = opts.onError || (() => {});
    this.input = null;
    this.hls = null;
    this.plan = [];
    this.duration = 0;
    this.audioTracks = [];
    this.audioIndex = 0;
    this.audioDisabled = false;
    this.segCache = new Map();
    this.initSegment = null;
    this.playlist = '';
    this.destroyed = false;
    this._segCtrls = new Set();
    this._failed = false;
    this._canvasSink = null;
    this._resumeHandler = null;
  }

  _emit(phase, pct) { if (!this.destroyed) { try { this.onPhase(phase, pct); } catch {} } }

  /** Open + probe + index + start MSE playback through hls.js. */
  async load(src, opts = {}) {
    this.destroy();
    this.destroyed = false;
    this.src = src;
    this.audioIndex = opts.audioIndex ?? 0;
    this.audioDisabled = opts.audioDisabled === true;
    this._resumeAt = opts.resumeAt || 0;

    try {
      await this._openAndIndex(opts);
    } catch (e) {
      // audio-converter problems → retry once, silently
      if (e?.code === 'audio' && opts.allowNoAudio !== true && !this.audioDisabled) {
        return this.load(src, { ...opts, audioDisabled: true, allowNoAudio: true });
      }
      throw e;
    }

    this._emit('prepare', 0);
    try {
      await this._processSegment(0);
    } catch (e) {
      if (e?.code === 'audio' && opts.allowNoAudio !== true && !this.audioDisabled) {
        return this.load(src, { ...opts, audioDisabled: true, allowNoAudio: true });
      }
      throw e;
    }
    if (this.destroyed) throw new EngineError('cancelled', 'Load cancelled');
    this.playlist = generateVodPlaylist({
      targetDuration: Math.ceil(Math.max(...this.plan.map(s => s.durationSec))) || 4,
      entries: this.plan.map(s => ({ uri: `seg-${s.sequence}.m4s`, durationSec: s.durationSec })),
    });
    this._emit('ready', 1);
    this._startHls();
    this._applyResume();
    return this;
  }

  async _openAndIndex(opts) {
    this._emit('probe');
    const source = typeof this.src === 'string' ? new UrlSource(this.src) : new BlobSource(this.src);
    this.input = new Input({ formats: ALL_FORMATS, source });
    let ok = false;
    try { ok = await this.input.canRead(); } catch { ok = false; }
    if (!ok) throw new EngineError('container', 'This container format can’t be read');

    this.videoTrack = await this.input.getPrimaryVideoTrack().catch(() => null);
    const aTracks = await this.input.getAudioTracks().catch(() => []);
    this.audioTracks = await Promise.all(aTracks.map(async (t, i) => {
      let name = null, lang = null;
      try { name = await t.getName(); } catch {}
      try { lang = await t.getLanguageCode(); } catch {}
      return { index: i, name, language: lang, codec: t.codec };
    }));
    if (this.audioDisabled) this.audioTrack = null;
    else this.audioTrack = aTracks[this.audioIndex] || aTracks[0] || null;

    // duration
    let dur = await this.input.getDurationFromMetadata().catch(() => null);
    if (!dur) dur = await this.input.computeDuration().catch(() => 0);
    if (!dur || !Number.isFinite(dur)) throw new EngineError('container', 'Could not determine duration');
    this.duration = dur;

    // video track checks
    this.videoCodec = null; this.videoSink = null;
    this.videoDecoderConfig = null; this.videoParam = null;
    if (this.videoTrack) {
      if (!await this.videoTrack.canDecode().catch(() => false))
        throw new EngineError('codec', 'This video codec isn’t supported by your browser');
      const vp = await this.videoTrack.getCodecParameterString().catch(() => null);
      this.videoParam = vp;
      if (vp && !mseOk(`video/mp4; codecs="${vp}"`))
        throw new EngineError('mse', `Video codec ${vp} can’t be played through MediaSource`);
      this.videoDecoderConfig = await this.videoTrack.getDecoderConfig().catch(() => null);
      if (!this.videoDecoderConfig) throw new EngineError('codec', 'Could not read the video decoder setup');
      this.videoCodec = this.videoTrack.codec;
      this.videoSink = new EncodedPacketSink(this.videoTrack);
    }

    // audio track checks
    this.needAudioXcode = false; this.audioCodec = null; this.audioSink = null;
    this.audioDecoderConfig = null; this.audioParam = null;
    if (this.audioTrack) {
      this.audioCodec = this.audioTrack.codec;
      const ap = await this.audioTrack.getCodecParameterString().catch(() => null);
      this.audioParam = ap;
      this.audioDecoderConfig = await this.audioTrack.getDecoderConfig().catch(() => null);
      this.needAudioXcode = audioNeedsTranscode(this.audioCodec, ap);
      if (this.needAudioXcode) {
        if (!AUDIO_XCODE_CODECS.has(this.audioCodec))
          throw new EngineError('codec', `Audio codec “${this.audioCodec}” needs conversion this tier can’t do`);
        this._emit('audio-core');
        await preloadAudioCore();          // EngineError('audio') on failure → retried without audio
        this.audioSink = new EncodedPacketSink(this.audioTrack);
      } else if (!this.audioDecoderConfig) {
        // unknown passthrough codec with no decoder config → keep video, drop audio
        this.audioTrack = null;
        this.audioDisabled = true;
        this.audioCodec = null;
      } else {
        this.audioSink = new EncodedPacketSink(this.audioTrack);
      }
    }

    // keyframe index → segment plan
    this._emit('index', 0);
    const bounds = [];
    if (this.videoSink) {
      let kf = await this.videoSink.getKeyPacket(0, { metadataOnly: true }).catch(() => null);
      if (!kf) {
        const first = await this.videoSink.getFirstPacket({ metadataOnly: true }).catch(() => null);
        if (first?.type === 'key') kf = first;
      }
      let n = 0;
      while (kf && !this.destroyed) {
        if (Number.isFinite(kf.timestamp) && kf.timestamp >= 0) bounds.push(kf.timestamp);
        if ((++n & 31) === 0) this._emit('index', Math.min(0.98, kf.timestamp / this.duration));
        const next = await this.videoSink.getNextKeyPacket(kf, { metadataOnly: true }).catch(() => null);
        if (!next || next.sequenceNumber === kf.sequenceNumber) break;
        kf = next;
      }
    }
    if (bounds.length < 2) {
      bounds.length = 0;
      for (let t = 0; t < this.duration; t += 4) bounds.push(t);
      bounds.push(this.duration);
    }
    this.plan = buildSegmentPlan({
      keyframeTimestampsSec: bounds, durationSec: this.duration, targetSegmentDurationSec: 4,
    });
    if (this.destroyed) throw new EngineError('cancelled', 'Load cancelled');
  }

  get info() {
    return {
      duration: this.duration,
      videoCodec: this.videoCodec,
      audioCodec: this.audioDisabled ? null : this.audioCodec,
      videoParam: this.videoParam || null,
      audioParam: this.audioDisabled ? null : (this.audioParam || null),
      audioTranscoded: this.needAudioXcode && !this.audioDisabled,
      segments: this.plan.length,
      audioTracks: this.audioTracks,
      audioIndex: this.audioDisabled ? -1 : this.audioIndex,
    };
  }

  async _processSegment(index, signal) {
    const key = index;
    if (this.segCache.has(key)) return this.segCache.get(key);
    const promise = this._buildSegment(index, signal);
    this.segCache.set(key, promise);
    if (this.segCache.size > 5) {
      for (const k of this.segCache.keys()) {
        if (k !== key) { this.segCache.delete(k); break; }
      }
    }
    try { return await promise; }
    catch (e) { if (this.segCache.get(key) === promise) this.segCache.delete(key); throw e; }
  }

  async _buildSegment(index, signal) {
    const seg = this.plan[index];
    if (!seg) throw new EngineError('hls', `Invalid segment ${index}`);
    const end = seg.startSec + seg.durationSec;

    const check = () => {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (this.destroyed) throw new DOMException('destroyed', 'AbortError');
    };
    check();

    const videoPackets = this.videoSink
      ? await collectPackets(this.videoSink, seg.startSec, end, true) : [];
    check();
    let audioPackets = this.audioSink
      ? await collectPackets(this.audioSink, seg.startSec, end, false) : [];
    check();

    let audioDecoderConfig = this.audioDecoderConfig;
    const wantXcode = this.needAudioXcode && !this.audioDisabled && audioPackets.length > 0;
    if (wantXcode) {
      const bytes = concat(audioPackets.map(p => p.data));
      const res = await transcodeAudioBytes(bytes, {
        codec: this.audioCodec,
        startSec: audioPackets[0].timestamp,
        sampleRate: this.audioDecoderConfig?.sampleRate ?? 48000,
      });
      audioPackets = res.packets;
      audioDecoderConfig = res.decoderConfig;
      check();
    }

    const muxed = await muxToFmp4({
      videoPackets, audioPackets,
      videoCodec: this.videoCodec,
      audioCodec: (!this.audioDisabled && this.audioCodec) ? (wantXcode ? 'aac' : this.audioCodec) : null,
      videoDecoderConfig: this.videoDecoderConfig,
      audioDecoderConfig,
    });
    if (!this.initSegment) this.initSegment = muxed.init;
    return concat(muxed.media);
  }

  /** Called by hls.js loaders. Returns an ArrayBuffer for the segment. */
  async requestSegment(index, ctrl) {
    if (ctrl) this._segCtrls.add(ctrl);
    try {
      const data = await this._processSegment(index, ctrl?.signal);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } finally {
      if (ctrl) this._segCtrls.delete(ctrl);
    }
  }

  _startHls() {
    if (!Hls.isSupported()) throw new EngineError('hls', 'MediaSource isn’t supported in this browser');
    const engine = this;
    const mkStats = () => {
      const now = performance.now();
      return {
        aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
        loading: { start: now, first: now, end: now },
        parsing: { start: now, end: now },
        buffering: { start: now, first: now, end: now },
      };
    };
    class PlaylistLoader {
      constructor() { this.stats = mkStats(); }
      load(ctx, _cfg, cb) {
        const data = engine.playlist;
        this.stats.loaded = data.length;
        this.stats.loading.end = performance.now();
        queueMicrotask(() => cb.onSuccess({ url: ctx.url, data }, this.stats, ctx, null));
      }
      abort() {} destroy() {}
    }
    class FragmentLoader {
      constructor() { this.stats = mkStats(); this.ctrl = null; }
      load(ctx, _cfg, cb) {
        this.stats = mkStats();
        this.ctrl = new AbortController();
        const url = ctx.url;
        if (url.includes('init.mp4')) {
          const data = engine.initSegment;
          if (!data) { cb.onError({ code: 0, text: 'No init segment' }, ctx, null, this.stats); return; }
          this.stats.loaded = data.byteLength;
          this.stats.loading.end = performance.now();
          queueMicrotask(() => { if (!this.ctrl.signal.aborted) cb.onSuccess({ url, data }, this.stats, ctx, null); });
          return;
        }
        const m = url.match(/seg-(\d+)\.m4s/);
        if (!m) { cb.onError({ code: 404, text: 'Unknown segment URL' }, ctx, null, this.stats); return; }
        const ctrl = this.ctrl;
        engine.requestSegment(+m[1], ctrl).then(buf => {
          if (ctrl.signal.aborted) return;
          this.ctrl = null;
          this.stats.loaded = buf.byteLength;
          this.stats.loading.end = performance.now();
          cb.onSuccess({ url, data: buf }, this.stats, ctx, null);
        }).catch(err => {
          if (ctrl.signal.aborted) return;
          this.ctrl = null;
          if (err?.name === 'AbortError') { this.stats.aborted = true; cb.onAbort?.(this.stats, ctx, null); return; }
          cb.onError({ code: 0, text: err?.message || String(err) }, ctx, null, this.stats);
        });
      }
      abort() {
        if (this.ctrl) { this.ctrl.abort(); this.ctrl = null; this.stats.aborted = true; }
      }
      destroy() { this.abort(); }
    }

    this.hls = new Hls({
      pLoader: PlaylistLoader,
      fLoader: FragmentLoader,
      enableWorker: false,
      backBufferLength: 90,
      maxBufferLength: 60,
      maxMaxBufferLength: 240,
    });
    this.hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || this._failed) return;
      this._failed = true;
      console.error('[reel] hls fatal', data);
      const msg = data.error?.message || data.reason || data.details;
      this.onError(new EngineError('hls', `Playback pipeline error: ${msg}`, data));
    });
    this.hls.loadSource('/virtual/playlist.m3u8');
    this.hls.attachMedia(this.video);
  }

  _applyResume() {
    const t = this._resumeAt;
    if (!t || t <= 1) return;
    const seek = () => {
      if (this.destroyed) return;
      if (this.video.duration && t < this.video.duration - 1) {
        try { this.video.currentTime = t; } catch {}
      }
      this.video.removeEventListener('loadedmetadata', seek);
      this._resumeHandler = null;
    };
    this._resumeHandler = seek;
    this.video.addEventListener('loadedmetadata', seek);
  }

  /** Render a preview frame into a canvas (seek-bar hover). */
  async drawPreview(ts, canvas) {
    if (!this.videoTrack) return false;
    if (!this._canvasSink) this._canvasSink = new CanvasSink(this.videoTrack, { width: canvas.width });
    try {
      const c = await this._canvasSink.getCanvas(Math.max(0, ts));
      if (!c) return false;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(c.canvas, 0, 0, canvas.width, canvas.height);
      return true;
    } catch { return false; }
  }

  destroy() {
    this.destroyed = true;
    for (const c of [...this._segCtrls]) { try { c.abort(); } catch {} }
    this._segCtrls.clear();
    if (this._resumeHandler) {
      this.video.removeEventListener('loadedmetadata', this._resumeHandler);
      this._resumeHandler = null;
    }
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }
    if (this.input) { try { this.input.dispose(); } catch {} this.input = null; }
    this._canvasSink = null;
    this.segCache.clear();
    this.initSegment = null;
    this.playlist = '';
    this.plan = [];
    this.videoTrack = null; this.videoSink = null; this.audioTrack = null; this.audioSink = null;
    this._failed = false;
    this._resumeAt = 0;
  }
}

/* ==================================================== tier 3: ffmpeg.wasm */

const CORE_JS = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';
const CORE_WASM = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';

export const FFMPEG_MAX_BYTES = 1.6e9;

const FFMPEG_MODES = ['remux', 'x264', 'mpeg4'];

function modeArgs(mode, inName, outName) {
  const base = ['-hide_banner', '-loglevel', 'error', '-i', inName];
  const tail = ['-movflags', '+faststart', '-y', outName];
  if (mode === 'remux') return [...base, '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', ...tail];
  if (mode === 'x264') return [...base,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', ...tail];
  return [...base,
    '-c:v', 'mpeg4', '-q:v', '4', '-vtag', 'xvid',
    '-c:a', 'aac', '-b:a', '160k', ...tail];
}

let ffP = null;
let ffBusy = false;

async function ensureFfmpeg() {
  if (ffP) return ffP;
  ffP = (async () => {
    const ff = new FFmpeg();
    await ff.load({ coreURL: CORE_JS, wasmURL: CORE_WASM });
    return ff;
  })();
  try { return await ffP; }
  catch (e) {
    ffP = null;
    throw new EngineError('ffmpeg', 'Could not load ffmpeg.wasm (offline or blocked by the network)', e);
  }
}

/**
 * Convert a file to MP4 in-browser. Tries modes in order until one both
 * succeeds AND passes `verify` (if provided):
 *   remux  — stream copy (fast, lossless)
 *   x264   — libx264 + aac (slow, broad compatibility)
 *   mpeg4  — mpeg4 part 2 + aac (last resort)
 */
export async function ffmpegConvert(file, { modes = FFMPEG_MODES, onProgress, verify, signal } = {}) {
  if (file.size > FFMPEG_MAX_BYTES)
    throw new EngineError('size', 'File is too large for in-browser conversion (limit ≈1.6 GB)');
  const ff = await ensureFfmpeg();
  if (ffBusy) throw new EngineError('ffmpeg', 'Another conversion is already running');
  ffBusy = true;
  const ext = extOf(file.name) || 'bin';
  const inName = `reel-in.${ext}`, outName = 'reel-out.mp4';
  let onProg;
  // cancelling mid-exec requires killing the worker (exec is uninterruptible)
  const onAbort = () => { try { ff.terminate(); } catch {} ffP = null; };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (const mode of modes) {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      onProg = ({ progress, time }) => {
        if (signal?.aborted) return;
        if (typeof progress === 'number' && progress > 0 && progress <= 1) onProgress?.({ mode, progress });
        else if (typeof time === 'number' && time > 0) onProgress?.({ mode, elapsed: time / 1000 });
      };
      ff.on?.('progress', onProg);
      onProgress?.({ mode, progress: 0 });
      // fresh copy per attempt — writeFile transfers the buffer away
      await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
      const code = await ff.exec(modeArgs(mode, inName, outName));
      try { await ff.deleteFile(inName); } catch {}
      ff.off?.('progress', onProg);
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (code !== 0) continue;
      const data = await ff.readFile(outName);
      try { await ff.deleteFile(outName); } catch {}
      const blob = new Blob([data], { type: 'video/mp4' });
      if (verify) { if (!await verify(blob)) continue; }
      onProgress?.({ mode, progress: 1 });
      return { blob, mode };
    }
    throw new EngineError('ffmpeg', 'Conversion failed: no conversion mode produced a playable file');
  } catch (e) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    if (e instanceof EngineError || e?.name === 'AbortError') throw e;
    throw new EngineError('ffmpeg', 'Conversion failed: ' + (e?.message || e), e);
  } finally {
    ffBusy = false;
    signal?.removeEventListener('abort', onAbort);
    if (onProg) ff.off?.('progress', onProg);
    try { await ff.deleteFile(inName); } catch {}
    try { await ff.deleteFile(outName); } catch {}
  }
}

export function ffmpegBusy() { return ffBusy; }
export function ffmpegLoaded() { return !!ffP; }

/** Tear down heavy resources (page unload / tests). */
export function shutdownEngine() {
  if (ffP) { ffP.then(ff => { try { ff.terminate(); } catch {} }).catch(() => {}); ffP = null; }
}
