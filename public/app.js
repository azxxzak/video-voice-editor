/* Video & Voice Editor — everything runs in the browser.
 *  - ffmpeg.wasm : video cutting, audio extraction, MP3 export
 *  - Web Audio   : waveform, recording, voice editing
 */
'use strict';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
function fmtSize(bytes) {
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function baseName(name) {
  return (name || 'file').replace(/\.[^.]+$/, '');
}
function safeExt(name, fallback) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : fallback;
}

let toastTimer;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isErr ? 7000 : 2500);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */
function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#tab-video').hidden = name !== 'video';
  $('#tab-audio').hidden = name !== 'audio';
  if (name === 'audio') requestAnimationFrame(drawWave);
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ------------------------------------------------------------------ */
/* ffmpeg.wasm helpers                                                 */
/* ------------------------------------------------------------------ */
let ffmpeg = null;
let ffmpegLoading = null;
let progressCb = null;
const ffLog = [];

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (!ffmpegLoading) {
    ffmpegLoading = (async () => {
      const ff = new FFmpegWASM.FFmpeg();
      ff.on('progress', ({ progress }) => {
        if (progressCb && isFinite(progress)) progressCb(clamp(progress, 0, 1));
      });
      ff.on('log', ({ message }) => {
        ffLog.push(message);
        if (ffLog.length > 40) ffLog.shift();
      });
      await ff.load({
        coreURL: new URL('vendor/ffmpeg-core.js', location.href).href,
        wasmURL: new URL('vendor/ffmpeg-core.wasm', location.href).href,
      });
      ffmpeg = ff;
      return ff;
    })();
    ffmpegLoading.catch(() => (ffmpegLoading = null));
  }
  return ffmpegLoading;
}

function resetFFmpeg() {
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch {}
  }
  ffmpeg = null;
  ffmpegLoading = null;
}

// Stream-copy keeps the codecs, so the output must use a container that can hold them
// (e.g. VP8/VP9 cannot go into .mp4). Keep the source container when it is a common one.
function copyExt(file) {
  const e = safeExt(file.name, 'mp4');
  return ['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(e) ? e : 'mp4';
}
function videoMime(ext) {
  return ext === 'webm' ? 'video/webm' : ext === 'mkv' ? 'video/x-matroska' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
}

let cancelled = false;
function setBar(p) {
  const bar = document.querySelector('#busy .bar');
  if (p == null) {
    bar.classList.add('indeterminate');
    $('#busyBar').style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    $('#busyBar').style.width = Math.round(p * 100) + '%';
  }
}
async function withBusy(label, fn) {
  cancelled = false;
  $('#busyLabel').textContent = label;
  setBar(null);
  $('#busy').hidden = false;
  try {
    return await fn();
  } catch (err) {
    if (!cancelled) {
      console.error(err);
      // a failed ffmpeg run leaves the wasm instance aborted: start fresh next time
      if (/ffmpeg failed/.test(String(err && err.message))) resetFFmpeg();
      toast(String(err && err.message ? err.message : err), true);
    }
    return null;
  } finally {
    progressCb = null;
    $('#busy').hidden = true;
  }
}
$('#busyCancel').addEventListener('click', () => {
  cancelled = true;
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch {}
  }
  ffmpeg = null;
  ffmpegLoading = null;
  $('#busy').hidden = true;
  toast('Cancelled');
});

/**
 * Run a sequence of ffmpeg steps on one input file.
 * steps: [{ args:[...], output:'name.ext' }]; the last step's output is returned.
 * Use the literal placeholder 'IN' inside args for the input file name.
 */
async function runSteps(file, steps, label) {
  const ff = await getFFmpeg();
  const inName = 'input.' + safeExt(file.name, 'mp4');
  await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  const made = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (label) $('#busyLabel').textContent = steps.length > 1 ? `${label} (${i + 1}/${steps.length})` : label;
      setBar(0);
      progressCb = (p) => setBar((i + p) / steps.length);
      ffLog.length = 0;
      const args = st.args.map((a) => (a === 'IN' ? inName : a));
      const code = await ff.exec(args);
      if (code !== 0) throw new Error('ffmpeg failed.\n' + ffLog.slice(-4).join('\n'));
      if (st.output) made.push(st.output);
    }
    const out = made[made.length - 1];
    const data = await ff.readFile(out);
    return data;
  } finally {
    for (const n of [inName, ...made, 'list.txt']) {
      try { await ff.deleteFile(n); } catch {}
    }
  }
}

/* ------------------------------------------------------------------ */
/* VIDEO TAB                                                           */
/* ------------------------------------------------------------------ */
const vid = { file: null, url: null, duration: 0, start: 0, end: 0, previewing: false };
const player = $('#vPlayer');
const tl = $('#vTimeline');

function vMode() {
  return document.querySelector('input[name=vmode]:checked').value;
}

$('#vFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) loadVideo(f);
});

function loadVideo(file) {
  if (vid.url) URL.revokeObjectURL(vid.url);
  vid.file = file;
  vid.url = URL.createObjectURL(file);
  vid.duration = 0;
  $('#vName').textContent = file.name + '  ·  ' + fmtSize(file.size);
  $('#vResults').innerHTML = '';
  player.src = vid.url;
  player.load();
}
player.addEventListener('loadedmetadata', () => {
  if (!isFinite(player.duration)) {
    toast('Could not read the length of this video.', true);
    return;
  }
  vid.duration = player.duration;
  vid.start = 0;
  vid.end = vid.duration;
  $('#vEditor').hidden = false;
  updateVideoUI();
});
player.addEventListener('error', () => {
  if (vid.file) toast('This browser cannot play that video file. Try an MP4 (H.264) or WebM.', true);
});
player.addEventListener('pause', () => (vid.previewing = false));

function tlPct(t) {
  return (vid.duration ? (t / vid.duration) * 100 : 0) + '%';
}
function updateVideoUI() {
  if (!vid.duration) return;
  const { start, end, duration } = vid;
  const mode = vMode();
  tl.classList.toggle('mode-cut', mode === 'cut');
  tl.classList.toggle('mode-keep', mode === 'keep');
  $('#vRange').style.left = tlPct(start);
  $('#vRange').style.width = ((end - start) / duration) * 100 + '%';
  $('#vHS').style.left = tlPct(start);
  $('#vHE').style.left = tlPct(end);
  $('#vStartT').textContent = fmt(start);
  $('#vEndT').textContent = fmt(end);
  const keepLen = mode === 'keep' ? end - start : duration - (end - start);
  $('#vSummary').textContent =
    mode === 'keep'
      ? `Result: ${fmt(start)} → ${fmt(end)}  (${fmt(keepLen)} long)`
      : `Remove ${fmt(start)} → ${fmt(end)}  ·  result is ${fmt(keepLen)} long`;
  $('#vFast').disabled = mode === 'cut';
  $('#vFastWrap').classList.toggle('disabled', mode === 'cut');
}
document.querySelectorAll('input[name=vmode]').forEach((r) => r.addEventListener('change', updateVideoUI));

// timeline interaction
let tlDrag = null;
function tlTime(ev) {
  const r = tl.getBoundingClientRect();
  return clamp((ev.clientX - r.left) / r.width, 0, 1) * vid.duration;
}
function tlApply(ev) {
  const t = tlTime(ev);
  if (tlDrag === 's') {
    vid.start = Math.min(t, vid.end - 0.05);
    player.currentTime = vid.start;
  } else if (tlDrag === 'e') {
    vid.end = Math.max(t, vid.start + 0.05);
    player.currentTime = Math.max(0, vid.end - 0.05);
  } else {
    player.currentTime = t;
  }
  updateVideoUI();
}
tl.addEventListener('pointerdown', (ev) => {
  if (!vid.duration) return;
  const h = ev.target.closest('.tl-handle');
  tlDrag = h ? (h.id === 'vHS' ? 's' : 'e') : 'seek';
  tl.setPointerCapture(ev.pointerId);
  tlApply(ev);
});
tl.addEventListener('pointermove', (ev) => tlDrag && tlApply(ev));
tl.addEventListener('pointerup', () => (tlDrag = null));
tl.addEventListener('pointercancel', () => (tlDrag = null));

$('#vSetStart').addEventListener('click', () => {
  vid.start = clamp(player.currentTime, 0, vid.duration);
  if (vid.end <= vid.start + 0.05) vid.end = vid.duration;
  updateVideoUI();
});
$('#vSetEnd').addEventListener('click', () => {
  vid.end = clamp(player.currentTime, 0, vid.duration);
  if (vid.start >= vid.end - 0.05) vid.start = 0;
  updateVideoUI();
});

$('#vPreview').addEventListener('click', () => {
  if (!vid.duration) return;
  player.currentTime = vMode() === 'keep' ? vid.start : Math.max(0, vid.start - 2);
  player.play();
  vid.previewing = true;
});

// playhead + preview logic (rAF so it is smooth)
function tick() {
  if (vid.duration) {
    const t = player.currentTime;
    $('#vPlayhead').style.left = tlPct(t);
    $('#vNowT').textContent = fmt(t);
    if (vid.previewing && !player.paused) {
      if (vMode() === 'keep') {
        if (t >= vid.end) player.pause();
      } else if (t >= vid.start && t < vid.end) {
        player.currentTime = vid.end;
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function addResult(blob, name, kind, extra) {
  const url = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'card result';
  const media = document.createElement(kind === 'video' ? 'video' : 'audio');
  media.controls = true;
  media.src = url;
  if (kind === 'video') media.playsInline = true;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('div');
  label.innerHTML = '<b></b> <span class="muted"></span>';
  label.querySelector('b').textContent = name;
  label.querySelector('span').textContent = fmtSize(blob.size);
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.margin = '0';
  if (extra) actions.appendChild(extra);
  const dl = document.createElement('a');
  dl.className = 'dl';
  dl.href = url;
  dl.download = name;
  dl.textContent = 'Download';
  actions.appendChild(dl);
  meta.append(label, actions);
  card.append(media, meta);
  $('#vResults').prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];

$('#vExport').addEventListener('click', async () => {
  if (!vid.file) return;
  const { start, end, duration } = vid;
  const mode = vMode();
  const T = (n) => n.toFixed(3);
  let outExt = 'mp4';
  let steps;

  if (mode === 'keep') {
    if (end - start < 0.1) return toast('The selected range is too short.', true);
    if ($('#vFast').checked) {
      outExt = copyExt(vid.file);
      const o = 'out.' + outExt;
      steps = [{ args: ['-ss', T(start), '-i', 'IN', '-t', T(end - start), '-c', 'copy', '-avoid_negative_ts', 'make_zero', o], output: o }];
    } else {
      steps = [{ args: ['-ss', T(start), '-i', 'IN', '-t', T(end - start), ...X264, 'out.mp4'], output: 'out.mp4' }];
    }
  } else {
    const hasA = start > 0.05;
    const hasB = end < duration - 0.05;
    if (!hasA && !hasB) return toast('Nothing would be left — move start or end.', true);
    steps = [];
    if (hasA) steps.push({ args: ['-i', 'IN', '-t', T(start), ...X264, 'a.mp4'], output: 'a.mp4' });
    if (hasB) steps.push({ args: ['-ss', T(end), '-i', 'IN', ...X264, 'b.mp4'], output: 'b.mp4' });
    if (hasA && hasB) {
      steps.push({ args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.mp4'], output: 'out.mp4', list: true });
    } else {
      // a single piece is already the result
      steps[0].args[steps[0].args.length - 1] = 'out.mp4';
      steps[0].output = 'out.mp4';
    }
  }

  const data = await withBusy('Loading video engine…', async () => {
    const ff = await getFFmpeg();
    const cutFiles = [];
    // custom runner (needs list.txt + several temp files for "cut middle")
    const inName = 'input.' + safeExt(vid.file.name, 'mp4');
    await ff.writeFile(inName, new Uint8Array(await vid.file.arrayBuffer()));
    try {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        $('#busyLabel').textContent = steps.length > 1 ? `Exporting video (${i + 1}/${steps.length})…` : 'Exporting video…';
        setBar(0);
        progressCb = (p) => setBar((i + p) / steps.length);
        if (st.list) {
          await ff.writeFile('list.txt', new TextEncoder().encode("file 'a.mp4'\nfile 'b.mp4'\n"));
        }
        ffLog.length = 0;
        const code = await ff.exec(st.args.map((a) => (a === 'IN' ? inName : a)));
        if (code !== 0) throw new Error('ffmpeg failed.\n' + ffLog.slice(-4).join('\n'));
        cutFiles.push(st.output);
      }
      return await ff.readFile(steps[steps.length - 1].output);
    } finally {
      for (const n of [inName, 'a.mp4', 'b.mp4', ...cutFiles, 'list.txt']) {
        try { await ff.deleteFile(n); } catch {}
      }
    }
  });
  const outName = baseName(vid.file.name) + (mode === 'keep' ? '_cropped' : '_cut') + '.' + outExt;
  if (data) addResult(new Blob([data.buffer], { type: videoMime(outExt) }), outName, 'video');
});

const AUD = {
  mp3: { args: ['-c:a', 'libmp3lame', '-b:a', '192k'], mime: 'audio/mpeg' },
  wav: { args: ['-c:a', 'pcm_s16le'], mime: 'audio/wav' },
  m4a: { args: ['-c:a', 'aac', '-b:a', '192k'], mime: 'audio/mp4' },
};

$('#vExtract').addEventListener('click', async () => {
  if (!vid.file) return;
  const f = $('#vAudFmt').value;
  const out = 'out.' + f;
  const data = await withBusy('Loading video engine…', () =>
    runSteps(vid.file, [{ args: ['-i', 'IN', '-vn', ...AUD[f].args, out], output: out }], 'Extracting audio…')
  );
  if (!data) return;
  const blob = new Blob([data.buffer], { type: AUD[f].mime });
  const name = baseName(vid.file.name) + '_audio.' + f;
  const edit = document.createElement('button');
  edit.textContent = 'Edit in Voice editor';
  edit.addEventListener('click', async () => {
    showTab('audio');
    await loadAudioBlob(blob, name);
  });
  addResult(blob, name, 'audio', edit);
});

$('#vMute').addEventListener('click', async () => {
  if (!vid.file) return;
  const ext = copyExt(vid.file);
  const out = 'out.' + ext;
  const data = await withBusy('Loading video engine…', () =>
    runSteps(vid.file, [{ args: ['-i', 'IN', '-c:v', 'copy', '-an', out], output: out }], 'Removing audio…')
  );
  if (data) addResult(new Blob([data.buffer], { type: videoMime(ext) }), baseName(vid.file.name) + '_muted.' + ext, 'video');
});

/* ------------------------------------------------------------------ */
/* AUDIO TAB                                                           */
/* ------------------------------------------------------------------ */
const actx = new (window.AudioContext || window.webkitAudioContext)();
let abuf = null;
let aname = 'recording';
const undoStack = [];
let sel = null; // {a,b} seconds
let cursor = 0; // seconds
let peaks = null;

function cloneBuffer(buf) {
  const nb = actx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) nb.copyToChannel(buf.getChannelData(c), c);
  return nb;
}
function setBuffer(nb, { keepUndo = true } = {}) {
  if (abuf && keepUndo) {
    undoStack.push(abuf);
    if (undoStack.length > 20) undoStack.shift();
  }
  stopPlayback();
  abuf = nb;
  peaks = null;
  sel = null;
  cursor = 0;
  $('#aEditor').hidden = false;
  updateAudioUI();
}
function updateAudioUI() {
  $('#aName').textContent = aname + (abuf ? `  ·  ${abuf.numberOfChannels === 1 ? 'mono' : 'stereo'}, ${abuf.sampleRate} Hz` : '');
  $('#aLenT').textContent = abuf ? fmt(abuf.duration) : '0:00.00';
  $('#aSelT').textContent = sel ? `${fmt(sel.a)} → ${fmt(sel.b)}  (${fmt(sel.b - sel.a)})` : 'none (drag on the waveform)';
  $('#aCurT').textContent = fmt(cursor);
  $('#aUndo').disabled = undoStack.length === 0;
  for (const id of ['aTrim', 'aCut', 'aSilence']) $('#' + id).disabled = !sel;
  drawWave();
}

async function loadAudioBlob(blob, name) {
  const ok = await withBusy('Reading audio…', async () => {
    let buf;
    try {
      buf = await actx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      // fall back to ffmpeg (handles video containers & odd codecs)
      const file = new File([blob], name || 'input.bin', { type: blob.type });
      $('#busyLabel').textContent = 'Loading audio engine…';
      const data = await runSteps(file, [{ args: ['-i', 'IN', '-vn', '-ac', '2', '-c:a', 'pcm_s16le', 'out.wav'], output: 'out.wav' }], 'Converting audio…');
      buf = await actx.decodeAudioData(data.buffer.slice(0));
    }
    aname = name || 'recording';
    setBuffer(buf);
    return true;
  });
  return ok;
}

$('#aFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await loadAudioBlob(f, f.name);
});

/* ---- waveform ---- */
const wave = $('#wave');
function computePeaks(w) {
  const n = abuf.length;
  const step = n / w;
  const mins = new Float32Array(w);
  const maxs = new Float32Array(w);
  const chans = [];
  for (let c = 0; c < abuf.numberOfChannels; c++) chans.push(abuf.getChannelData(c));
  for (let x = 0; x < w; x++) {
    const i0 = Math.floor(x * step);
    const i1 = Math.max(i0 + 1, Math.min(n, Math.floor((x + 1) * step)));
    const stride = Math.max(1, Math.floor((i1 - i0) / 48));
    let mn = 0, mx = 0;
    for (const d of chans) {
      for (let i = i0; i < i1; i += stride) {
        const v = d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    mins[x] = mn;
    maxs[x] = mx;
  }
  return { w, buf: abuf, mins, maxs };
}
function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}
let playPos = null; // seconds while playing
function drawWave() {
  if ($('#tab-audio').hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, wave.clientWidth);
  const h = wave.clientHeight;
  if (wave.width !== Math.round(w * dpr) || wave.height !== Math.round(h * dpr)) {
    wave.width = Math.round(w * dpr);
    wave.height = Math.round(h * dpr);
  }
  const g = wave.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!abuf) return;
  if (!peaks || peaks.buf !== abuf || peaks.w !== w) peaks = computePeaks(w);
  const mid = h / 2;
  g.fillStyle = cssVar('--wave');
  for (let x = 0; x < w; x++) {
    const y1 = mid - peaks.maxs[x] * mid * 0.95;
    const y2 = mid - peaks.mins[x] * mid * 0.95;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  g.fillStyle = cssVar('--line');
  g.fillRect(0, mid, w, 1);
  const px = (t) => (t / abuf.duration) * w;
  if (sel) {
    g.fillStyle = cssVar('--sel');
    g.fillRect(px(sel.a), 0, px(sel.b) - px(sel.a), h);
  }
  g.fillStyle = cssVar('--text');
  g.fillRect(px(playPos != null ? playPos : cursor), 0, 2, h);
}
window.addEventListener('resize', drawWave);

let wDrag = null;
function waveTime(ev) {
  const r = wave.getBoundingClientRect();
  return clamp((ev.clientX - r.left) / r.width, 0, 1) * (abuf ? abuf.duration : 0);
}
wave.addEventListener('pointerdown', (ev) => {
  if (!abuf) return;
  wave.setPointerCapture(ev.pointerId);
  wDrag = { x0: ev.clientX, t0: waveTime(ev), moved: false };
});
wave.addEventListener('pointermove', (ev) => {
  if (!wDrag) return;
  if (!wDrag.moved && Math.abs(ev.clientX - wDrag.x0) < 4) return;
  wDrag.moved = true;
  const t = waveTime(ev);
  sel = { a: Math.min(wDrag.t0, t), b: Math.max(wDrag.t0, t) };
  updateAudioUI();
});
wave.addEventListener('pointerup', () => {
  if (wDrag && !wDrag.moved) {
    cursor = wDrag.t0;
    sel = null;
    updateAudioUI();
  }
  if (sel && sel.b - sel.a < 0.01) sel = null;
  wDrag = null;
  updateAudioUI();
});

/* ---- playback ---- */
let curSrc = null;
let playInfo = null;
let raf = 0;
function stopPlayback() {
  if (curSrc) {
    const s = curSrc;
    curSrc = null;
    try { s.stop(); } catch {}
  }
  cancelAnimationFrame(raf);
  playPos = null;
  $('#aPlay').textContent = '▶ Play';
  drawWave();
}
function startPlayback() {
  if (!abuf) return;
  stopPlayback();
  actx.resume();
  let from = cursor;
  let to = abuf.duration;
  if (sel) { from = sel.a; to = sel.b; }
  if (from >= to - 0.01) from = 0;
  const src = actx.createBufferSource();
  src.buffer = abuf;
  src.connect(actx.destination);
  src.start(0, from, to - from);
  curSrc = src;
  playInfo = { t0: actx.currentTime, from, to };
  src.onended = () => {
    if (curSrc === src) {
      curSrc = null;
      stopPlayback();
    }
  };
  $('#aPlay').textContent = '■ Stop';
  const loop = () => {
    if (!curSrc) return;
    playPos = Math.min(playInfo.to, playInfo.from + (actx.currentTime - playInfo.t0));
    drawWave();
    raf = requestAnimationFrame(loop);
  };
  loop();
}
$('#aPlay').addEventListener('click', () => (curSrc ? stopPlayback() : startPlayback()));
$('#aSelAll').addEventListener('click', () => {
  if (!abuf) return;
  sel = { a: 0, b: abuf.duration };
  updateAudioUI();
});
$('#aClearSel').addEventListener('click', () => {
  sel = null;
  updateAudioUI();
});
$('#aUndo').addEventListener('click', () => {
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  stopPlayback();
  abuf = prev;
  peaks = null;
  sel = null;
  cursor = 0;
  updateAudioUI();
});
document.addEventListener('keydown', (e) => {
  if ($('#tab-audio').hidden || !abuf) return;
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    curSrc ? stopPlayback() : startPlayback();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    $('#aUndo').click();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (sel) {
      e.preventDefault();
      $('#aCut').click();
    }
  }
});

/* ---- editing operations ---- */
function regionSamples(requireSel) {
  const sr = abuf.sampleRate;
  if (sel) {
    const a = clamp(Math.floor(sel.a * sr), 0, abuf.length);
    const b = clamp(Math.ceil(sel.b * sr), 0, abuf.length);
    return b > a ? [a, b] : null;
  }
  return requireSel ? null : [0, abuf.length];
}
function needSel() {
  toast('Drag on the waveform to select a part first.', true);
}
function sliceBuffer(parts) {
  // parts: array of [a,b] sample ranges concatenated in order
  const total = parts.reduce((n, [a, b]) => n + (b - a), 0);
  if (total < 1) return null;
  const nb = actx.createBuffer(abuf.numberOfChannels, total, abuf.sampleRate);
  for (let c = 0; c < abuf.numberOfChannels; c++) {
    const src = abuf.getChannelData(c);
    const dst = nb.getChannelData(c);
    let o = 0;
    for (const [a, b] of parts) {
      dst.set(src.subarray(a, b), o);
      o += b - a;
    }
  }
  return nb;
}
function modify(requireSel, fn) {
  if (!abuf) return;
  const r = regionSamples(requireSel);
  if (!r) return needSel();
  const nb = cloneBuffer(abuf);
  for (let c = 0; c < nb.numberOfChannels; c++) fn(nb.getChannelData(c), r[0], r[1]);
  const keepSel = sel ? { ...sel } : null;
  const keepCursor = cursor;
  setBuffer(nb);
  sel = keepSel;
  cursor = keepCursor;
  updateAudioUI();
}

$('#aTrim').addEventListener('click', () => {
  const r = abuf && regionSamples(true);
  if (!r) return needSel();
  const nb = sliceBuffer([r]);
  if (nb) setBuffer(nb);
});
$('#aCut').addEventListener('click', () => {
  const r = abuf && regionSamples(true);
  if (!r) return needSel();
  const nb = sliceBuffer([[0, r[0]], [r[1], abuf.length]]);
  if (!nb) return toast('Nothing would be left.', true);
  const at = r[0] / abuf.sampleRate;
  setBuffer(nb);
  cursor = Math.min(at, nb.duration);
  updateAudioUI();
});
$('#aSilence').addEventListener('click', () => modify(true, (d, a, b) => d.fill(0, a, b)));

$('#aVolume').addEventListener('click', () => {
  const db = parseFloat($('#aGain').value);
  if (!isFinite(db)) return toast('Enter a volume change in dB.', true);
  const g = Math.pow(10, db / 20);
  modify(false, (d, a, b) => {
    for (let i = a; i < b; i++) d[i] = clamp(d[i] * g, -1, 1);
  });
});
$('#aNormalize').addEventListener('click', () => {
  if (!abuf) return;
  const r = regionSamples(false);
  let peak = 0;
  for (let c = 0; c < abuf.numberOfChannels; c++) {
    const d = abuf.getChannelData(c);
    for (let i = r[0]; i < r[1]; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak < 1e-5) return toast('The selection is silent.', true);
  const g = Math.pow(10, -1 / 20) / peak; // peak at -1 dBFS
  modify(false, (d, a, b) => {
    for (let i = a; i < b; i++) d[i] = clamp(d[i] * g, -1, 1);
  });
});
function fadeLenSamples(a, b) {
  const s = parseFloat($('#aFadeLen').value) || 1;
  return Math.max(1, Math.min(b - a, Math.round(s * abuf.sampleRate)));
}
$('#aFadeIn').addEventListener('click', () => {
  if (!abuf) return;
  modify(false, (d, a, b) => {
    const n = fadeLenSamples(a, b);
    for (let i = 0; i < n; i++) d[a + i] *= i / n;
  });
});
$('#aFadeOut').addEventListener('click', () => {
  if (!abuf) return;
  modify(false, (d, a, b) => {
    const n = fadeLenSamples(a, b);
    for (let i = 0; i < n; i++) d[b - 1 - i] *= i / n;
  });
});
$('#aAutoTrim').addEventListener('click', () => {
  if (!abuf) return;
  const thr = Math.pow(10, -45 / 20);
  const n = abuf.length;
  let first = n, last = -1;
  for (let c = 0; c < abuf.numberOfChannels; c++) {
    const d = abuf.getChannelData(c);
    for (let i = 0; i < n; i++) if (Math.abs(d[i]) > thr) { first = Math.min(first, i); break; }
    for (let i = n - 1; i >= 0; i--) if (Math.abs(d[i]) > thr) { last = Math.max(last, i); break; }
  }
  if (last < 0) return toast('The whole recording is silent.', true);
  const pad = Math.round(0.1 * abuf.sampleRate); // keep 100 ms of air around the voice
  const a = Math.max(0, first - pad);
  const b = Math.min(n, last + pad);
  if (a === 0 && b === n) return toast('No silence to trim at the ends.');
  setBuffer(sliceBuffer([[a, b]]));
});

/* ---- recording ---- */
let rec = null;
$('#recBtn').addEventListener('click', async () => {
  if (rec) return stopRecording();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return toast('Recording needs a secure page (https or localhost) and a browser with microphone support.', true);
  }
  try {
    await actx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: $('#recNS').checked, echoCancellation: $('#recEC').checked, autoGainControl: false },
    });
    const mr = new MediaRecorder(stream);
    const chunks = [];
    const src = actx.createMediaStreamSource(stream);
    const an = actx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    const t0 = performance.now();
    let frame = 0;
    const meter = () => {
      an.getByteTimeDomainData(data);
      let pk = 0;
      for (const v of data) pk = Math.max(pk, Math.abs(v - 128));
      $('#recLevel').style.width = Math.min(100, (pk / 128) * 140) + '%';
      $('#recTime').textContent = fmt((performance.now() - t0) / 1000).replace(/\.\d+$/, '');
      frame = requestAnimationFrame(meter);
    };
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      cancelAnimationFrame(frame);
      stream.getTracks().forEach((t) => t.stop());
      src.disconnect();
      rec = null;
      $('#recBtn').textContent = '● Record voice';
      $('#recBtn').classList.remove('on');
      $('#recMeter').hidden = true;
      $('#recTime').hidden = true;
      if (chunks.length) await loadAudioBlob(new Blob(chunks, { type: mr.mimeType }), 'recording-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') );
    };
    mr.start();
    rec = { mr };
    $('#recBtn').textContent = '■ Stop recording';
    $('#recBtn').classList.add('on');
    $('#recMeter').hidden = false;
    $('#recTime').hidden = false;
    meter();
  } catch (err) {
    toast('Could not use the microphone: ' + (err.message || err), true);
  }
});
function stopRecording() {
  if (rec && rec.mr.state !== 'inactive') rec.mr.stop();
}

/* ---- export ---- */
function encodeWav(buf) {
  const nch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const bytes = 44 + len * nch * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nch * 2, true);
  const chans = [];
  for (let c = 0; c < nch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const s = clamp(chans[c][i], -1, 1);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return ab;
}
$('#aExport').addEventListener('click', async () => {
  if (!abuf) return;
  const fmtSel = $('#aFmt').value;
  const name = baseName(aname) + '_edited';
  const wav = encodeWav(abuf);
  if (fmtSel === 'wav') return download(new Blob([wav], { type: 'audio/wav' }), name + '.wav');
  const data = await withBusy('Loading audio engine…', () =>
    runSteps(new File([wav], 'in.wav'), [{ args: ['-i', 'IN', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'], output: 'out.mp3' }], 'Encoding MP3…')
  );
  if (data) download(new Blob([data.buffer], { type: 'audio/mpeg' }), name + '.mp3');
});

updateAudioUI();
