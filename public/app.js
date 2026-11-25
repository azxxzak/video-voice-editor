/* Видео ба дуу засагч — бүх зүйл хөтөч дотор ажиллана.
 *  - ffmpeg.wasm : видео тайрах, дуу салгах, MP3 болгох
 *  - Web Audio   : дууны долгион, хураалт, дуу засвар
 */
'use strict';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ICON = (id, cls = '') => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;

function fmt(t) {
  t = isFinite(t) ? Math.round(t * 100) / 100 : 0; // 59.999 → 60 (0:60.00 гэж гаргахгүй)
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = (t - h * 3600 - m * 60).toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function fmtSize(bytes) {
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function baseName(name) {
  return (name || 'файл').replace(/\.[^.]+$/, '');
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
  toastTimer = setTimeout(() => (el.hidden = true), isErr ? 7000 : 2800);
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
/* Цэс (Видео / Дуу)                                                   */
/* ------------------------------------------------------------------ */
function showTab(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#tab-video').hidden = name !== 'video';
  $('#tab-audio').hidden = name !== 'audio';
  window.scrollTo({ top: 0 });
  if (name === 'audio') requestAnimationFrame(drawWave);
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ------------------------------------------------------------------ */
/* ffmpeg.wasm                                                         */
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
        if (ffLog.length > 400) ffLog.shift();
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

// Stream-copy нь кодекийг хэвээр хадгалдаг тул гаралтын формат тохирох ёстой
// (жишээ нь VP8/VP9 нь .mp4 дотор багтдаггүй).
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
const LOADING_ENGINE = 'Боловсруулагчийг ачаалж байна… (анх удаа ~30MB, түр хүлээнэ үү)';

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
      const msg = String(err && err.message ? err.message : err);
      if (/memory|allocation|RangeError|OOM/i.test(msg)) {
        resetFFmpeg();
        toast('Үр дүнгийн файл хэт том болж хөтөчийн санах ой хүрсэнгүй. Арай богино хэсэг сонгоод дахин оролдоно уу.', true);
      } else if (/ffmpeg failed/.test(msg)) {
        resetFFmpeg();
        toast('Боловсруулалт амжилтгүй боллоо. Өөр файл эсвэл MP4 хэлбэртэй видеогоор оролдоно уу.', true);
      } else {
        toast('Алдаа гарлаа: ' + String(err && err.message ? err.message : err), true);
      }
    }
    return null;
  } finally {
    progressCb = null;
    $('#busy').hidden = true;
  }
}
$('#busyCancel').addEventListener('click', () => {
  cancelled = true;
  resetFFmpeg();
  $('#busy').hidden = true;
  toast('Цуцаллаа');
});

/** Файлыг санах ой руу хуулалгүй (хэдэн GB ч байсан) ffmpeg-д дискнээс нь шууд уншуулна. */
let mountSeq = 0;
async function withInput(ff, file, fn) {
  const dir = '/in' + ++mountSeq;
  await ff.createDir(dir);
  await ff.mount('WORKERFS', { files: [file] }, dir);
  try {
    return await fn(`${dir}/${file.name}`);
  } finally {
    try { await ff.unmount(dir); } catch {}
    try { await ff.deleteDir(dir); } catch {}
  }
}

/** Видео/дууны урт, кодекийг ffmpeg-ээр уншина. */
async function probeMedia(file) {
  const ff = await getFFmpeg();
  return withInput(ff, file, async (path) => {
    ffLog.length = 0;
    await ff.exec(['-hide_banner', '-i', path, '-t', '0', '-f', 'null', '-']);
    const log = ffLog.join('\n');
    const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    const vm = /Stream #[^\n]*?Video:\s*([a-z0-9_]+)([^\n]*)/i.exec(log);
    const am = /Stream #[^\n]*?Audio:\s*([a-z0-9_]+)([^\n]*)/i.exec(log);
    const res = vm && /\b(\d{2,5})x(\d{2,5})\b/.exec(vm[2]);
    const abr = am && /(\d+) kb\/s/.exec(am[2]);
    const ar = am && /(\d+) Hz/.exec(am[2]);
    return {
      duration: dm ? +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]) : 0,
      vcodec: vm ? vm[1].toLowerCase() : null,
      acodec: am ? am[1].toLowerCase() : null,
      width: res ? +res[1] : 0,
      height: res ? +res[2] : 0,
      abitrate: abr ? +abr[1] : 0,
      arate: ar ? +ar[1] : 0,
    };
  });
}

/** Нэг оролтын файл дээр ffmpeg-ийн алхмуудыг дараалан ажиллуулна. 'IN' нь оролтын файл. */
async function runSteps(file, steps, label) {
  const ff = await getFFmpeg();
  const data = await withInput(ff, file, (inPath) => runStepsOn(ff, inPath, steps, label));
  // том файл гаргасны дараа ffmpeg-ийн санах ой дүүрч дараагийн ажил гацдаг байсан
  if (data && data.length > 50 * 1048576) resetFFmpeg();
  return data;
}

/** MP4/MOV файлын видеоны keyframe-үүдийн цагийг (секунд) moov-оос шууд уншина. Бусад форматад null. */
async function mp4Keyframes(file) {
  const rd = async (pos, len) => new DataView(await file.slice(pos, pos + len).arrayBuffer());
  let pos = 0;
  let mv = null;
  while (pos + 8 <= file.size) {
    const h = await rd(pos, 16);
    let len = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (len === 1) len = Number(h.getBigUint64(8));
    else if (len === 0) len = file.size - pos;
    if (len < 8) return null;
    if (type === 'moov') {
      if (len > 300 * 1048576) return null;
      mv = await rd(pos, len);
      break;
    }
    pos += len;
  }
  if (!mv) return null;
  const u32 = (o) => mv.getUint32(o);
  const str4 = (o) => String.fromCharCode(mv.getUint8(o), mv.getUint8(o + 1), mv.getUint8(o + 2), mv.getUint8(o + 3));
  const kids = (a, b) => {
    const out = [];
    for (let o = a; o + 8 <= b; ) {
      let len = u32(o);
      if (len === 1) len = Number(mv.getBigUint64(o + 8));
      if (len < 8 || o + len > b) break;
      out.push({ t: str4(o + 4), a: o, b: o + len });
      o += len;
    }
    return out;
  };
  const pick = (list, t) => list.find((x) => x.t === t);
  const top = kids(8, mv.byteLength);
  const mvhd = pick(top, 'mvhd');
  const movieScale = mvhd ? (mv.getUint8(mvhd.a + 8) === 1 ? u32(mvhd.a + 28) : u32(mvhd.a + 20)) : 0;
  for (const trak of top.filter((x) => x.t === 'trak')) {
    const tk = kids(trak.a + 8, trak.b);
    const mdia = pick(tk, 'mdia');
    if (!mdia) continue;
    const md = kids(mdia.a + 8, mdia.b);
    const hdlr = pick(md, 'hdlr');
    const mdhd = pick(md, 'mdhd');
    if (!hdlr || !mdhd || str4(hdlr.a + 16) !== 'vide') continue;
    const scale = mv.getUint8(mdhd.a + 8) === 1 ? u32(mdhd.a + 28) : u32(mdhd.a + 20);
    const minf = pick(md, 'minf');
    const stbl = minf && pick(kids(minf.a + 8, minf.b), 'stbl');
    if (!stbl || !scale) return null;
    const sb = kids(stbl.a + 8, stbl.b);
    const stts = pick(sb, 'stts');
    const stss = pick(sb, 'stss');
    const ctts = pick(sb, 'ctts');
    if (!stts || !stss) return null; // stss байхгүй = бүх кадр keyframe (тайрахад зөрөхгүй)
    // edit list: эхний хоосон хэсэг ба media_time шилжилт
    let shift = 0;
    const edts = pick(tk, 'edts');
    const elst = edts && pick(kids(edts.a + 8, edts.b), 'elst');
    if (elst) {
      const v1 = mv.getUint8(elst.a + 8) === 1;
      const n = u32(elst.a + 12);
      for (let i = 0, o = elst.a + 16; i < n; i++, o += v1 ? 20 : 12) {
        const segDur = v1 ? Number(mv.getBigUint64(o)) : u32(o);
        const mediaTime = v1 ? Number(mv.getBigInt64(o + 8)) : mv.getInt32(o + 4);
        if (mediaTime === -1) { if (movieScale) shift += segDur / movieScale; continue; }
        shift -= mediaTime / scale;
        break;
      }
    }
    const nKeys = u32(stss.a + 12);
    const keys = [];
    for (let i = 0; i < nKeys; i++) keys.push(u32(stss.a + 16 + i * 4) - 1); // 0-ээс эхэлсэн дугаар
    // кадр бүрийн dts (stts), pts шилжилт (ctts)
    let ki = 0, sample = 0, dts = 0;
    const dtsOf = new Map();
    const nStts = u32(stts.a + 12);
    for (let e = 0; e < nStts && ki < keys.length; e++) {
      const cnt = u32(stts.a + 16 + e * 8);
      const delta = u32(stts.a + 20 + e * 8);
      while (ki < keys.length && keys[ki] < sample + cnt) {
        dtsOf.set(keys[ki], dts + (keys[ki] - sample) * delta);
        ki++;
      }
      sample += cnt;
      dts += cnt * delta;
    }
    const ctOf = new Map();
    if (ctts) {
      const v1 = mv.getUint8(ctts.a + 8) === 1;
      const nC = u32(ctts.a + 12);
      let s0 = 0, kj = 0;
      for (let e = 0; e < nC && kj < keys.length; e++) {
        const cnt = u32(ctts.a + 16 + e * 8);
        const off = v1 ? mv.getInt32(ctts.a + 20 + e * 8) : u32(ctts.a + 20 + e * 8);
        while (kj < keys.length && keys[kj] < s0 + cnt) { ctOf.set(keys[kj], off); kj++; }
        s0 += cnt;
      }
    }
    return keys.filter((k) => dtsOf.has(k)).map((k) => (dtsOf.get(k) + (ctOf.get(k) || 0)) / scale + shift).sort((x, y) => x - y);
  }
  return null;
}
async function runStepsOn(ff, inName, steps, label) {
  const made = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (label) $('#busyLabel').textContent = steps.length > 1 ? `${label} (${i + 1}/${steps.length})` : label;
      setBar(0);
      progressCb = (p) => setBar((i + p) / steps.length);
      ffLog.length = 0;
      if (st.list) await ff.writeFile('list.txt', new TextEncoder().encode(st.list));
      const code = await ff.exec(st.args.map((a) => (a === 'IN' ? inName : a)));
      if (code !== 0) throw new Error('ffmpeg failed.\n' + ffLog.slice(-4).join('\n'));
      if (st.output) made.push(st.output);
    }
    return await ff.readFile(made[made.length - 1]);
  } finally {
    for (const n of [...made, 'list.txt']) {
      try { await ff.deleteFile(n); } catch {}
    }
  }
}

/* ------------------------------------------------------------------ */
/* ВИДЕО                                                               */
/* ------------------------------------------------------------------ */
const vid = { file: null, url: null, duration: 0, start: 0, end: 0, previewing: false, playable: true, info: null, setupFor: null, probing: null, keys: null, w: 0, h: 0 };
const LONG_VIDEO = 10 * 60; // үүнээс урт видеонд «анхны дуугаараа» салгахыг санал болгоно
const vQuality = () => document.querySelector('input[name=vq]:checked').value;
// t-ээс өмнөх (эсвэл яг t дээрх) хамгийн ойрын keyframe
function keyBefore(t) {
  const k = vid.keys;
  if (!k || !k.length) return t;
  let lo = 0, hi = k.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (k[mid] <= t + 0.01) { best = k[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return Math.max(0, best);
}
const CODEC_NAMES = { hevc: 'HEVC (H.265)', h265: 'HEVC (H.265)', av1: 'AV1', mpeg4: 'MPEG-4 Part 2', prores: 'ProRes', vp9: 'VP9', h264: 'H.264', mpeg2video: 'MPEG-2', wmv3: 'WMV', msmpeg4v3: 'DivX' };
const player = $('#vPlayer');
const tl = $('#vTimeline');

const vMode = () => document.querySelector('input[name=vmode]:checked').value;

for (const id of ['#vFile', '#vFile2']) {
  $(id).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadVideo(f);
  });
}

function loadVideo(file) {
  if (vid.url) URL.revokeObjectURL(vid.url);
  vid.file = file;
  vid.url = URL.createObjectURL(file);
  vid.duration = 0;
  vid.playable = true;
  vid.info = null;
  vid.setupFor = null;
  vid.probing = null;
  vid.keys = null;
  vid.w = vid.h = 0;
  player.hidden = false;
  $('#vNoPreview').hidden = true;
  $('#vName').textContent = file.name + ' · ' + fmtSize(file.size);
  $('#vResults').innerHTML = '';
  player.src = vid.url;
  player.load();
}
player.addEventListener('loadedmetadata', () => {
  if (!vid.file || vid.setupFor === vid.file || vid.probing === vid.file) return;
  // урт нь тодорхойгүй эсвэл зөвхөн дуу нь тоглож байвал (videoWidth 0) кодекийг шалгана
  if (!isFinite(player.duration) || !player.duration || player.videoWidth === 0) {
    handleUnplayable();
    return;
  }
  vid.playable = true;
  setupVideoEditor(player.duration);
});
player.addEventListener('error', () => {
  if (vid.file && vid.setupFor !== vid.file) handleUnplayable();
});

// Хөтөч тоглуулж чадахгүй видео (ихэвчлэн HEVC/H.265): урьдчилж үзэхгүйгээр засварлана
async function handleUnplayable() {
  const file = vid.file;
  if (vid.probing === file || vid.setupFor === file) return;
  vid.probing = file;
  const info = await withBusy('Видеог шалгаж байна…', () => probeMedia(file));
  if (vid.file !== file) return;
  vid.probing = null;
  if (!info || !info.duration) {
    return toast('Энэ файлыг уншиж чадсангүй. Файл эвдэрсэн эсвэл видео биш байж магадгүй.', true);
  }
  if (!info.vcodec) {
    return toast('Энэ файлд видео алга байна. Дууны файл бол «Дуу» хэсэгт нээнэ үү.', true);
  }
  vid.playable = false;
  vid.info = info;
  setupVideoEditor(info.duration);
}

function setupVideoEditor(duration) {
  vid.setupFor = vid.file;
  vid.duration = duration;
  vid.start = 0;
  vid.end = duration;
  $('#vEmpty').hidden = true;
  $('#vEditor').hidden = false;
  $('#vTotalT').textContent = fmt(duration);
  player.hidden = !vid.playable;
  const np = $('#vNoPreview');
  np.hidden = vid.playable;
  if (!vid.playable) {
    const c = vid.info && vid.info.vcodec;
    const name = CODEC_NAMES[c] || (c ? c.toUpperCase() : 'энэ');
    np.innerHTML = `<b>Энэ хөтөч дээр урьдчилж үзэх боломжгүй</b>` +
      `Видео нь <b style="display:inline">${name}</b> кодектой тул энэ хөтөч тоглуулж чадахгүй байна. ` +
      `Гэхдээ доор минут, секундээ бичээд таслах, дууг нь салгах боломжтой.` +
      `<span class="muted">Урьдчилж үзэх бол Safari (Mac, iPhone) эсвэл Microsoft Edge дээр нээнэ үү.</span>`;
  }
  for (const id of ['#vPreview', '#vSetStart', '#vSetEnd']) $(id).disabled = !vid.playable;
  // 1 цагаас урт бол «цаг» нүдийг харуулна
  document.querySelectorAll('#task-cut .hbox').forEach((el) => (el.hidden = duration < 3600));
  $('#vAudFmt').value = duration > LONG_VIDEO ? 'copy' : 'mp3';
  document.querySelector('input[name=vq][value=copy]').checked = true;
  vid.w = vid.playable ? player.videoWidth : (vid.info && vid.info.width) || 0;
  vid.h = vid.playable ? player.videoHeight : (vid.info && vid.info.height) || 0;
  vRangeError = '';
  updateVideoUI();
  // keyframe-үүдийг уншаад «анхны чанараар» тайрах бодит цэгийг урьдчилж харуулна
  const file = vid.file;
  mp4Keyframes(file)
    .then((k) => { if (vid.file === file) { vid.keys = k; updateVideoUI(); } })
    .catch((e) => console.warn('keyframes', e));
}
player.addEventListener('pause', () => (vid.previewing = false));

// Таслах / Дуу салгах / Дуугүй болгох
document.querySelectorAll('.seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    for (const t of ['cut', 'audio', 'mute']) $('#task-' + t).hidden = t !== b.dataset.task;
  })
);

const tlPct = (t) => (vid.duration ? (t / vid.duration) * 100 : 0) + '%';

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
  syncVideoInputs();
  const exact = vQuality() === 'exact';
  // «анхны чанараар» үед бодит тайрах цэг: эхлэл (эсвэл хасах хэсгийн төгсгөл) өмнөх keyframe руу ухарна
  let effStart = start;
  let effEnd = end;
  let snap = '';
  vid.copyImpossible = false;
  if (!exact && vid.keys) {
    if (mode === 'keep') {
      const k = keyBefore(start);
      if (start - k > 0.3) {
        effStart = k;
        snap = `Анхны чанараар гаргахад видео ${mmssText(k)}-ээс эхэлнэ (таны бичсэнээс ${mmssText(start - k)} эрт).`;
      }
    } else {
      const k = keyBefore(end);
      if (end - k > 0.3) {
        if (k <= start + 0.05) {
          vid.copyImpossible = true;
          snap = 'Энэ хэсгийг анхны чанараар хасах боломжгүй (хоёр цэг нэг keyframe-ийн дотор байна). «Яг секундээр»-ийг сонгоно уу.';
        } else {
          effEnd = k;
          snap = `Анхны чанараар гаргахад хасагдах хэсэг ${mmssText(k)}-д дуусна (таны бичсэнээс ${mmssText(end - k)} эрт), тэр хооронд нь үлдэнэ.`;
        }
      }
    }
  }
  const resultLen = mode === 'keep' ? end - effStart : duration - (effEnd - start);
  const sum = $('#vSummary');
  sum.classList.toggle('err', !!vRangeError);
  sum.textContent = vRangeError
    ? vRangeError
    : mode === 'keep'
      ? `Үлдэх хэсэг: ${mmssText(effStart)} → ${mmssText(end)} · үр дүн ${mmssText(resultLen)}`
      : `Хасагдах хэсэг: ${mmssText(start)} → ${mmssText(effEnd)} · үр дүн ${mmssText(resultLen)}`;
  const note = $('#vQNote');
  let text = '';
  if (exact) {
    // хөтөч дотор 1080p ойролцоогоор бодит хугацаанаас 1.5 дахин хурдан кодлогддог
    const px = (vid.w || 1280) * (vid.h || 720);
    const speed = Math.min(20, (1.5 * 1920 * 1080) / px);
    const mins = resultLen / speed / 60;
    text = mins < 1
      ? 'Яг секундээр: ойролцоогоор 1 минутаас бага хугацаа шаардана.'
      : `Яг секундээр: ойролцоогоор ${Math.ceil(mins)} минут шаардана (компьютерийн хурдаас хамаарна).` +
        (mins > 15 ? ' Удаан тул боломжтой бол «Анхны чанараар»-ыг ашиглана уу.' : '');
  } else if (snap) {
    const k = vid.keys;
    const gap = k && k.length > 1 ? (k[k.length - 1] - k[0]) / (k.length - 1) : 0;
    text = snap + (gap > 1 ? ` Энэ видеонд keyframe ойролцоогоор ${Math.round(gap)} секунд тутамд байна.` : '') +
      (vid.copyImpossible ? '' : ' Яг секундээр хүсвэл «Яг секундээр»-ийг сонгоно уу.');
  } else if (!vid.keys) {
    text = '';
  }
  note.hidden = !text || !!vRangeError;
  note.textContent = text;
}
document.querySelectorAll('input[name=vq]').forEach((r) => r.addEventListener('change', updateVideoUI));
document.querySelectorAll('input[name=vmode]').forEach((r) => r.addEventListener('change', updateVideoUI));

// цагийн шугам (хулгана ба хуруу)
let tlDrag = null;
function tlTime(ev) {
  const r = tl.getBoundingClientRect();
  return clamp((ev.clientX - r.left) / r.width, 0, 1) * vid.duration;
}
function tlApply(ev) {
  const t = tlTime(ev);
  if (tlDrag === 's') {
    vid.start = Math.min(t, vid.end - 0.05);
    if (vid.playable) player.currentTime = vid.start;
  } else if (tlDrag === 'e') {
    vid.end = Math.max(t, vid.start + 0.05);
    if (vid.playable) player.currentTime = Math.max(0, vid.end - 0.05);
  } else if (vid.playable) {
    player.currentTime = t;
  }
  updateVideoUI();
}
tl.addEventListener('pointerdown', (ev) => {
  if (!vid.duration) return;
  ev.preventDefault();
  const h = ev.target.closest('.tl-handle');
  if (h) tlDrag = h.id === 'vHS' ? 's' : 'e';
  else {
    // хамгийн ойр бариулыг сонгох (хуруугаар барихад хялбар)
    const t = tlTime(ev);
    const px = (x) => Math.abs(x - t) / vid.duration * tl.getBoundingClientRect().width;
    tlDrag = Math.min(px(vid.start), px(vid.end)) < 14 ? (px(vid.start) < px(vid.end) ? 's' : 'e') : 'seek';
  }
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

/* ---- видео: «хэдэн мин, сек-ээс хэдэн мин, сек хүртэл» ---- */
// (splitMS, mmssText, readField, writeField нь доорх дууны хэсэгт байгаа ерөнхий функцууд)
const VIN = {
  from: { h: $('#vFromH'), m: $('#vFromM'), s: $('#vFromS') },
  to: { h: $('#vToH'), m: $('#vToM'), s: $('#vToS') },
};
const vInputs = [VIN.from.h, VIN.from.m, VIN.from.s, VIN.to.h, VIN.to.m, VIN.to.s];
let vRangeError = '';
const typingVideoRange = () => vInputs.includes(document.activeElement);

function syncVideoInputs() {
  // хэрэглэгч бичиж байх үед дарж бичихгүй; бичиж дуусахад зөв утгаар нь цэгцэлнэ
  if (typingVideoRange()) return;
  writeField(VIN.from, vid.start);
  writeField(VIN.to, vid.end);
  vRangeError = '';
}
function applyVideoInputs() {
  if (!vid.duration) return;
  const dur = vid.duration;
  let a = readField(VIN.from);
  let b = readField(VIN.to);
  if (a === null) a = 0; // хоосон эхлэх = видеоны эхлэл
  if (b === null) b = dur; // хоосон дуусах = видеоны төгсгөл
  vRangeError = '';
  if (isNaN(a) || isNaN(b)) {
    vRangeError = 'Зөвхөн тоо бичнэ үү. Жишээ нь 1 мин 30 сек.';
  } else if (a >= dur) {
    VIN.from.h.classList.add('bad');
    VIN.from.m.classList.add('bad');
    VIN.from.s.classList.add('bad');
    vRangeError = `Эхлэх цаг видеоны уртаас хэтэрсэн байна. Нийт урт ${mmssText(dur)}.`;
  } else if (b <= a + 0.05) {
    VIN.to.h.classList.add('bad');
    VIN.to.m.classList.add('bad');
    VIN.to.s.classList.add('bad');
    vRangeError = '«Дуусах» нь «Эхлэх»-ээс хойно байх ёстой.';
  } else {
    vid.start = a;
    vid.end = Math.min(dur, b); // уртаас хэтэрвэл төгсгөл хүртэл
  }
  updateVideoUI();
}
vInputs.forEach((el, i) => {
  el.addEventListener('input', applyVideoInputs);
  el.addEventListener('focus', () => el.select());
  el.addEventListener('blur', () => setTimeout(() => {
    if (!typingVideoRange()) {
      vRangeError = ''; // буруу утгыг сүүлийн зөв утгаар нь буцаана
      updateVideoUI();
    }
  }, 0));
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = vInputs.slice(i + 1).find((x) => !x.parentElement.hidden);
    if (next) next.focus();
    else el.blur();
  });
});

$('#vPreview').addEventListener('click', () => {
  if (!vid.duration) return;
  player.currentTime = vMode() === 'keep' ? vid.start : Math.max(0, vid.start - 2);
  player.play();
  vid.previewing = true;
});

function tick() {
  if (vid.duration && !$('#tab-video').hidden) {
    const t = player.currentTime;
    $('#vPlayhead').style.left = tlPct(t);
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

function addResult(blob, name, kind, extraBtn) {
  const url = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'card result';
  const media = document.createElement(kind === 'video' ? 'video' : 'audio');
  media.controls = true;
  media.src = url;
  if (kind === 'video') media.playsInline = true;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const info = document.createElement('div');
  info.innerHTML = '<div class="ok">✓ Бэлэн боллоо</div><div><b></b> <span class="muted"></span></div>';
  info.querySelector('b').textContent = name;
  info.querySelector('.muted').textContent = fmtSize(blob.size);
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (extraBtn) actions.appendChild(extraBtn);
  const dl = document.createElement('a');
  dl.className = 'btn dl';
  dl.href = url;
  dl.download = name;
  dl.innerHTML = ICON('download') + ' Татаж авах';
  actions.appendChild(dl);
  meta.append(info, actions);
  card.append(media, meta);
  $('#vResults').prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

const X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

$('#vExport').addEventListener('click', async () => {
  if (!vid.file) return;
  const { start, end, duration } = vid;
  const mode = vMode();
  const T = (n) => n.toFixed(3);
  const fast = vQuality() === 'copy';
  if (fast && vid.copyImpossible) return toast('Энэ хэсгийг анхны чанараар хасах боломжгүй. «Яг секундээр»-ийг сонгоно уу.', true);
  // анхны чанараар: кодекийг хэвээр хуулна (анхны формат), яг секундээр: H.264 MP4 болгож дахин кодлоно
  const ext = fast ? copyExt(vid.file) : 'mp4';
  const ENC = fast ? ['-c', 'copy', '-avoid_negative_ts', 'make_zero'] : X264;
  let steps;

  if (mode === 'keep') {
    if (end - start < 0.1) return toast('Сонгосон хэсэг хэт богино байна.', true);
    steps = [{ args: ['-ss', T(start), '-i', 'IN', '-t', T(end - start), ...ENC, 'out.' + ext], output: 'out.' + ext }];
  } else {
    const hasA = start > 0.05;
    const hasB = end < duration - 0.05;
    if (!hasA && !hasB) return toast('Юу ч үлдэхгүй байна. Эхлэл эсвэл төгсгөлөө зөөнө үү.', true);
    steps = [];
    if (hasA) steps.push({ args: ['-i', 'IN', '-t', T(start), ...ENC, 'a.' + ext], output: 'a.' + ext });
    if (hasB) steps.push({ args: ['-ss', T(end), '-i', 'IN', ...ENC, 'b.' + ext], output: 'b.' + ext });
    if (hasA && hasB) {
      steps.push({
        args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.' + ext],
        output: 'out.' + ext,
        list: `file 'a.${ext}'\nfile 'b.${ext}'\n`,
      });
    } else {
      steps[0].args[steps[0].args.length - 1] = 'out.' + ext;
      steps[0].output = 'out.' + ext;
    }
  }

  const data = await withBusy(LOADING_ENGINE, () => runSteps(vid.file, steps, 'Видео үүсгэж байна…'));
  const suffix = mode === 'keep' ? '_тайрсан' : '_таслсан';
  if (data) addResult(new Blob([data.buffer], { type: videoMime(ext) }), baseName(vid.file.name) + suffix + '.' + ext, 'video');
});

const AUD = {
  mp3: { args: ['-c:a', 'libmp3lame', '-b:a', '192k'], mime: 'audio/mpeg' },
  wav: { args: ['-c:a', 'pcm_s16le'], mime: 'audio/wav' },
  m4a: { args: ['-c:a', 'aac', '-b:a', '192k'], mime: 'audio/mp4' },
};

const COPY_AUDIO = {
  aac: ['m4a', 'audio/mp4'], alac: ['m4a', 'audio/mp4'], mp3: ['mp3', 'audio/mpeg'], opus: ['ogg', 'audio/ogg'],
  vorbis: ['ogg', 'audio/ogg'], flac: ['flac', 'audio/flac'], ac3: ['ac3', 'audio/ac3'], eac3: ['eac3', 'audio/eac3'],
};
$('#vExtract').addEventListener('click', async () => {
  if (!vid.file) return;
  const sel = $('#vAudFmt').value;
  let f = sel;
  let mime;
  const data = await withBusy(LOADING_ENGINE, async () => {
    let args;
    if (sel === 'copy') {
      const info = vid.info || (vid.info = await probeMedia(vid.file));
      if (!info.acodec) throw new Error('Энэ видеонд дуу алга байна.');
      const c = info.acodec.startsWith('pcm_') ? ['wav', 'audio/wav'] : COPY_AUDIO[info.acodec] || ['mka', 'audio/x-matroska'];
      [f, mime] = c;
      args = ['-c:a', 'copy'];
    } else {
      args = AUD[sel].args;
      mime = AUD[sel].mime;
    }
    const out = 'out.' + f;
    return runSteps(vid.file, [{ args: ['-i', 'IN', '-vn', '-map', '0:a:0', ...args, out], output: out }], 'Дууг салгаж байна…');
  });
  if (!data) return;
  const blob = new Blob([data.buffer], { type: mime });
  const name = baseName(vid.file.name) + '_дуу.' + f;
  const edit = document.createElement('button');
  edit.className = 'btn';
  edit.textContent = 'Дуу засагчид нээх';
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
  const data = await withBusy(LOADING_ENGINE, () =>
    runSteps(vid.file, [{ args: ['-i', 'IN', '-c:v', 'copy', '-an', out], output: out }], 'Дууг хасаж байна…')
  );
  if (data) addResult(new Blob([data.buffer], { type: videoMime(ext) }), baseName(vid.file.name) + '_дуугүй.' + ext, 'video');
});

/* ------------------------------------------------------------------ */
/* ДУУ                                                                 */
/* ------------------------------------------------------------------ */
const actx = new (window.AudioContext || window.webkitAudioContext)();
let abuf = null;
let aname = 'бичлэг';
const undoStack = [];
let sel = null; // {a,b} секундээр
let cursor = 0;
let peaks = null;
let rec = null;

function cloneBuffer(buf) {
  const nb = actx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) nb.copyToChannel(buf.getChannelData(c), c);
  return nb;
}
function updateAudioView() {
  const recording = !!rec;
  $('#recPanel').hidden = !recording;
  $('#aEmpty').hidden = recording || !!abuf;
  $('#aEditor').hidden = recording || !abuf;
}
function setBuffer(nb) {
  if (abuf) {
    undoStack.push(abuf);
    if (undoStack.length > 20) undoStack.shift();
  }
  stopPlayback();
  abuf = nb;
  peaks = null;
  sel = null;
  rangeDraft = false;
  rangeError = '';
  cursor = 0;
  updateAudioView();
  updateAudioUI();
}
function updateAudioUI() {
  $('#aName').textContent = aname + (abuf ? ` · ${abuf.numberOfChannels === 1 ? 'моно' : 'стерео'}` : '');
  $('#aLenT').textContent = abuf ? fmt(abuf.duration) : '0:00.00';
  $('#aSelT').textContent = sel ? fmt(sel.b - sel.a) : '—';
  $('#aCurT').textContent = fmt(cursor);
  $('#aUndo').disabled = undoStack.length === 0;
  for (const id of ['aTrim', 'aCut', 'aSilence']) $('#' + id).disabled = !sel;
  syncRangeInputs();
  if (!curSrc) setPlayUI(false); // «Тоглуулах» / «Сонгосныг тоглуулах» бичвэр
  drawWave();
}

/* ---- «хэдэн мин, сек-ээс хэдэн мин, сек хүртэл» талбар ---- */
const RIN = {
  from: { m: $('#aFromM'), s: $('#aFromS') },
  to: { m: $('#aToM'), s: $('#aToS') },
};
const rangeInputs = [RIN.from.m, RIN.from.s, RIN.to.m, RIN.to.s];
let rangeError = '';
let rangeDraft = false; // зөвхөн нэг тал нь бөглөгдсөн (эсвэл алдаатай) үед талбарыг арилгахгүй
const round2 = (t) => Math.round(t * 100) / 100;

function splitMS(t) {
  t = round2(Math.max(0, t));
  let m = Math.floor(t / 60);
  let s = round2(t - m * 60);
  if (s >= 60) { m += 1; s = 0; }
  return [m, s];
}
// 918.5 → "15 мин 18.5 сек", 45 → "45 сек", 5832 → "1 цаг 37 мин 12 сек"
function mmssText(t) {
  const [m, s] = splitMS(t);
  if (m >= 60) return `${Math.floor(m / 60)} цаг ${m % 60} мин ${s} сек`;
  return m > 0 ? `${m} мин ${s} сек` : `${s} сек`;
}
const hoursShown = (f) => f.h && !f.h.parentElement.hidden;
function num(str) {
  const s = String(str).trim().replace(/,/g, '.');
  if (!s) return 0; // хоосон нүд = 0
  return /^\d+(\.\d*)?$|^\.\d+$/.test(s) ? parseFloat(s) : NaN;
}
// талбар → секунд. Хоёр нүд хоёулаа хоосон бол null.
function readField(f) {
  const hs = hoursShown(f);
  const boxes = hs ? [f.h, f.m, f.s] : [f.m, f.s];
  if (boxes.every((b) => !b.value.trim())) {
    boxes.forEach((b) => b.classList.remove('bad'));
    return null;
  }
  const h = hs ? num(f.h.value) : 0;
  const m = num(f.m.value);
  const s = num(f.s.value);
  if (hs) f.h.classList.toggle('bad', isNaN(h));
  f.m.classList.toggle('bad', isNaN(m));
  f.s.classList.toggle('bad', isNaN(s));
  return isNaN(h) || isNaN(m) || isNaN(s) ? NaN : h * 3600 + m * 60 + s;
}
function writeField(f, t) {
  const hs = hoursShown(f);
  for (const b of [f.h, f.m, f.s]) if (b) b.classList.remove('bad');
  if (t == null) {
    for (const b of [f.h, f.m, f.s]) if (b) b.value = '';
    return;
  }
  let [m, s] = splitMS(t);
  if (hs) {
    f.h.value = String(Math.floor(m / 60));
    m %= 60;
  }
  f.m.value = String(m);
  f.s.value = String(s);
}
const typingRange = () => rangeInputs.includes(document.activeElement);

function syncRangeInputs() {
  if (!typingRange()) {
    if (sel) {
      // 0 мин 90 сек → 1 мин 30 сек гэх мэтээр цэгцэлж харуулна
      writeField(RIN.from, sel.a);
      writeField(RIN.to, sel.b);
      rangeDraft = false;
      rangeError = '';
    } else if (!rangeDraft) {
      writeField(RIN.from, null);
      writeField(RIN.to, null);
    }
  }
  const hint = $('#aSelHint');
  hint.classList.toggle('err', !!rangeError);
  if (rangeError) {
    hint.textContent = rangeError;
  } else if (sel) {
    hint.textContent = `Сонгосон: ${mmssText(sel.a)} → ${mmssText(sel.b)} (нийт ${mmssText(sel.b - sel.a)}). «Устгах» дарвал энэ хэсэг хасагдана.`;
  } else if (rangeDraft) {
    const a = readField(RIN.from);
    hint.textContent = a != null
      ? `Эхлэх: ${mmssText(a)}. Одоо «Дуусах»-аа оруулна уу.`
      : `Дуусах: ${mmssText(readField(RIN.to))}. Одоо «Эхлэх»-ээ оруулна уу.`;
  } else {
    hint.textContent = abuf ? `Нийт урт ${mmssText(abuf.duration)}. Хэсэг сонгоно уу.` : 'Эхлээд хэсэг сонгоно уу.';
  }
}

function applyRangeInputs() {
  if (!abuf) return;
  const dur = abuf.duration;
  const a = readField(RIN.from);
  const b = readField(RIN.to);
  rangeError = '';
  rangeDraft = false;
  sel = null;
  if ((a !== null && isNaN(a)) || (b !== null && isNaN(b))) {
    rangeError = 'Зөвхөн тоо бичнэ үү. Жишээ нь 15 мин 18 сек.';
  } else if (a === null && b === null) {
    // хоёулаа хоосон
  } else if (a === null || b === null) {
    rangeDraft = true;
  } else if (a >= dur) {
    RIN.from.m.classList.add('bad');
    RIN.from.s.classList.add('bad');
    rangeError = `Эхлэх цаг дууны уртаас хэтэрсэн байна. Нийт урт ${mmssText(dur)}.`;
  } else if (b <= a) {
    RIN.to.m.classList.add('bad');
    RIN.to.s.classList.add('bad');
    rangeError = '«Дуусах» нь «Эхлэх»-ээс хойно байх ёстой.';
  } else {
    sel = { a, b: Math.min(dur, b) }; // уртаас хэтэрвэл төгсгөл хүртэл
  }
  if (rangeError) rangeDraft = true;
  updateAudioUI();
}

// «Одоогийн цэг»: тоглуулж байгаа бол тоглож буй цэг, үгүй бол долгион дээр товшсон цэг
const nowPoint = () => (playPos != null ? playPos : cursor);
$('#aFromHere').addEventListener('click', () => {
  if (!abuf) return;
  writeField(RIN.from, nowPoint());
  applyRangeInputs();
});
$('#aToHere').addEventListener('click', () => {
  if (!abuf) return;
  writeField(RIN.to, nowPoint());
  applyRangeInputs();
});

rangeInputs.forEach((el, i) => {
  el.addEventListener('input', applyRangeInputs);
  el.addEventListener('focus', () => el.select());
  // бичиж дуусаад гарахад утгыг цэгцэлнэ
  el.addEventListener('blur', () => setTimeout(() => {
    if (!typingRange()) updateAudioUI();
  }, 0));
  // Enter: дараагийн нүд рүү (мин → сек → дуусах мин → дуусах сек)
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (rangeInputs[i + 1]) rangeInputs[i + 1].focus();
    else el.blur();
  });
});

let aSrc = null; // засварын өмнөх эх файл («анхны форматаар» хадгалахад)
let aSrcInfo = null;
async function loadAudioBlob(blob, name) {
  return withBusy('Дууг уншиж байна…', async () => {
    let buf;
    try {
      buf = await actx.decodeAudioData(await blob.arrayBuffer());
    } catch {
      // ffmpeg-ээр хөрвүүлж үзнэ (видео файл, ер бусын кодек)
      $('#busyLabel').textContent = LOADING_ENGINE;
      const file = new File([blob], name || 'input.bin', { type: blob.type });
      const data = await runSteps(file, [{ args: ['-i', 'IN', '-vn', '-ac', '2', '-c:a', 'pcm_s16le', 'out.wav'], output: 'out.wav' }], 'Дууг хөрвүүлж байна…');
      buf = await actx.decodeAudioData(data.buffer.slice(0));
    }
    aname = name || 'бичлэг';
    aSrc = { blob, name: aname };
    aSrcInfo = null;
    undoStack.length = 0; // шинэ файл: «өөрчлөлтгүй» эсэхийг зөв мэдэхийн тулд
    abuf = null;
    setBuffer(buf);
    showTab('audio');
    return true;
  });
}

for (const id of ['#aFile', '#aFile2']) {
  $(id).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await loadAudioBlob(f, f.name);
  });
}

/* ---- долгион ---- */
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
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let playPos = null;

function drawWave() {
  if ($('#tab-audio').hidden || $('#aEditor').hidden) return;
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
    g.fillRect(x, y1, 1, Math.max(1.5, y2 - y1));
  }
  const px = (t) => (t / abuf.duration) * w;
  if (sel) {
    g.fillStyle = cssVar('--sel');
    g.fillRect(px(sel.a), 0, px(sel.b) - px(sel.a), h);
    g.fillStyle = cssVar('--accent');
    for (const t of [sel.a, sel.b]) {
      g.fillRect(px(t) - 1.5, 0, 3, h);
      g.beginPath();
      g.arc(px(t), h / 2, 9, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = cssVar('--text');
  g.fillRect(px(playPos != null ? playPos : cursor) - 1, 0, 2, h);
}
window.addEventListener('resize', drawWave);

// сонголт: шинээр чирэх эсвэл хоёр захыг нь чирж өөрчлөх
let wDrag = null;
function waveTime(ev) {
  const r = wave.getBoundingClientRect();
  return clamp((ev.clientX - r.left) / r.width, 0, 1) * (abuf ? abuf.duration : 0);
}
wave.addEventListener('pointerdown', (ev) => {
  if (!abuf) return;
  ev.preventDefault();
  wave.setPointerCapture(ev.pointerId);
  const r = wave.getBoundingClientRect();
  const t = waveTime(ev);
  const near = (tt) => Math.abs(((tt - t) / abuf.duration) * r.width) < 20;
  if (sel && near(sel.a) && (!near(sel.b) || Math.abs(sel.a - t) <= Math.abs(sel.b - t))) {
    wDrag = { x0: ev.clientX, fixed: sel.b, edge: true, moved: false };
  } else if (sel && near(sel.b)) {
    wDrag = { x0: ev.clientX, fixed: sel.a, edge: true, moved: false };
  } else {
    wDrag = { x0: ev.clientX, fixed: t, edge: false, moved: false };
  }
});
wave.addEventListener('pointermove', (ev) => {
  if (!wDrag) return;
  if (!wDrag.moved && !wDrag.edge && Math.abs(ev.clientX - wDrag.x0) < 5) return;
  wDrag.moved = true;
  const t = waveTime(ev);
  sel = { a: Math.min(wDrag.fixed, t), b: Math.max(wDrag.fixed, t) };
  updateAudioUI();
});
function endWaveDrag(ev) {
  if (!wDrag) return;
  if (!wDrag.moved && !wDrag.edge) {
    cursor = waveTime(ev);
    sel = null;
  }
  if (sel && sel.b - sel.a < 0.02) sel = null;
  wDrag = null;
  updateAudioUI();
}
wave.addEventListener('pointerup', endWaveDrag);
wave.addEventListener('pointercancel', () => { wDrag = null; });

/* ---- тоглуулах ---- */
let curSrc = null;
let playInfo = null;
let raf = 0;
function setPlayUI(playing) {
  $('#aPlay').innerHTML = (playing ? ICON('stop') : ICON('play')) + `<span>${playing ? 'Зогсоох' : sel ? 'Сонгосныг тоглуулах' : 'Тоглуулах'}</span>`;
}
function stopPlayback() {
  if (curSrc) {
    const s = curSrc;
    curSrc = null;
    try { s.stop(); } catch {}
  }
  cancelAnimationFrame(raf);
  playPos = null;
  setPlayUI(false);
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
  setPlayUI(true);
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
  setPlayUI(!!curSrc);
});
$('#aClearSel').addEventListener('click', () => {
  sel = null;
  rangeDraft = false;
  rangeError = '';
  updateAudioUI();
  setPlayUI(!!curSrc);
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
  if ($('#tab-audio').hidden || !abuf || $('#aEditor').hidden) return;
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    curSrc ? stopPlayback() : startPlayback();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    $('#aUndo').click();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
    e.preventDefault();
    $('#aCut').click();
  }
});

/* ---- засварууд ---- */
function regionSamples(requireSel) {
  const sr = abuf.sampleRate;
  if (sel) {
    const a = clamp(Math.floor(sel.a * sr), 0, abuf.length);
    const b = clamp(Math.ceil(sel.b * sr), 0, abuf.length);
    return b > a ? [a, b] : null;
  }
  return requireSel ? null : [0, abuf.length];
}
const needSel = () => toast('Эхлээд долгион дээр чирж хэсэг сонгоно уу.', true);
function sliceBuffer(parts) {
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
function modify(requireSel, fn, doneMsg) {
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
  if (doneMsg) toast(doneMsg);
}

$('#aTrim').addEventListener('click', () => {
  const r = abuf && regionSamples(true);
  if (!r) return needSel();
  const nb = sliceBuffer([r]);
  if (nb) { setBuffer(nb); toast('Сонгосон хэсгийг үлдээлээ'); }
});
$('#aCut').addEventListener('click', () => {
  const r = abuf && regionSamples(true);
  if (!r) return needSel();
  const nb = sliceBuffer([[0, r[0]], [r[1], abuf.length]]);
  if (!nb) return toast('Юу ч үлдэхгүй байна.', true);
  const at = r[0] / abuf.sampleRate;
  setBuffer(nb);
  cursor = Math.min(at, nb.duration);
  updateAudioUI();
  toast('Сонгосон хэсгийг устгалаа');
});
$('#aSilence').addEventListener('click', () => modify(true, (d, a, b) => d.fill(0, a, b), 'Сонгосон хэсэг дуугүй боллоо'));

const gainSlider = $('#aGain');
function showGain() {
  const v = +gainSlider.value;
  $('#aGainV').textContent = (v > 0 ? '+' : '') + v + ' дБ';
}
gainSlider.addEventListener('input', showGain);
showGain();
$('#aVolume').addEventListener('click', () => {
  const g = Math.pow(10, +gainSlider.value / 20);
  modify(false, (d, a, b) => {
    for (let i = a; i < b; i++) d[i] = clamp(d[i] * g, -1, 1);
  }, 'Дууны хэмжээг өөрчиллөө');
});
$('#aNormalize').addEventListener('click', () => {
  if (!abuf) return;
  const r = regionSamples(false);
  let peak = 0;
  for (let c = 0; c < abuf.numberOfChannels; c++) {
    const d = abuf.getChannelData(c);
    for (let i = r[0]; i < r[1]; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak < 1e-5) return toast('Энэ хэсэг чимээгүй байна.', true);
  const g = Math.pow(10, -1 / 20) / peak;
  modify(false, (d, a, b) => {
    for (let i = a; i < b; i++) d[i] = clamp(d[i] * g, -1, 1);
  }, 'Дууг тэгшлэлээ');
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
  }, 'Аажим эхлэх болголоо');
});
$('#aFadeOut').addEventListener('click', () => {
  if (!abuf) return;
  modify(false, (d, a, b) => {
    const n = fadeLenSamples(a, b);
    for (let i = 0; i < n; i++) d[b - 1 - i] *= i / n;
  }, 'Аажим дуусах болголоо');
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
  if (last < 0) return toast('Бүх дуу чимээгүй байна.', true);
  const pad = Math.round(0.1 * abuf.sampleRate);
  const a = Math.max(0, first - pad);
  const b = Math.min(n, last + pad);
  if (a === 0 && b === n) return toast('Эхлэл, төгсгөлд хасах чимээгүй хэсэг алга.');
  setBuffer(sliceBuffer([[a, b]]));
  toast('Чимээгүй хэсгийг хаслаа');
});

/* ---- хураалт ---- */
function micError(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return 'Микрофоны зөвшөөрөл өгөөгүй байна. Хөтчийн хаягийн мөрний тохиргооноос микрофоныг зөвшөөрөөд дахин оролдоно уу.';
  }
  if (err && err.name === 'NotFoundError') return 'Микрофон олдсонгүй.';
  return 'Микрофоныг ашиглаж чадсангүй: ' + ((err && err.message) || err);
}
async function startRecording() {
  if (rec) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    return toast('Энэ хөтөч дээр хураах боломжгүй байна. Chrome, Safari эсвэл Firefox ашиглана уу.', true);
  }
  let stream;
  try {
    await actx.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: $('#recNS').checked, echoCancellation: $('#recEC').checked, autoGainControl: false },
    });
  } catch (err) {
    return toast(micError(err), true);
  }
  stopPlayback();
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
    const s = Math.floor((performance.now() - t0) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    frame = requestAnimationFrame(meter);
  };
  rec = { mr, cancelled: false };
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    cancelAnimationFrame(frame);
    stream.getTracks().forEach((t) => t.stop());
    src.disconnect();
    const cancel = rec && rec.cancelled;
    rec = null;
    updateAudioView();
    if (!cancel && chunks.length) {
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0');
      await loadAudioBlob(new Blob(chunks, { type: mr.mimeType }), 'Бичлэг ' + hhmm);
    }
  };
  mr.start();
  showTab('audio');
  updateAudioView();
  meter();
}
$('#recBtn').addEventListener('click', startRecording);
$('#recBtn2').addEventListener('click', startRecording);
$('#recStop').addEventListener('click', () => rec && rec.mr.state !== 'inactive' && rec.mr.stop());
$('#recCancel').addEventListener('click', () => {
  if (!rec) return;
  rec.cancelled = true;
  if (rec.mr.state !== 'inactive') rec.mr.stop();
});

/* ---- хадгалах ---- */
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
// эх файлын кодекоор дахин хадгалах тохиргоо
function origAudioPlan(info, srcName, srcType) {
  const br = (info.abitrate ? Math.max(32, info.abitrate) : 192) + 'k';
  const ar = info.arate ? ['-ar', String(info.arate)] : [];
  const sx = safeExt(srcName, '') || ((/audio\/(\w+)|video\/(\w+)/.exec(srcType || '') || [])[1] || (/video\/(\w+)/.exec(srcType || '') || [])[1] || '');
  const c = info.acodec || '';
  if (c === 'aac') return { ext: 'm4a', mime: 'audio/mp4', label: 'M4A (AAC)', args: ['-c:a', 'aac', '-b:a', br, ...ar] };
  if (c === 'mp3') return { ext: 'mp3', mime: 'audio/mpeg', label: 'MP3', args: ['-c:a', 'libmp3lame', '-b:a', br, ...ar] };
  if (c === 'opus') {
    const ext = ['webm', 'ogg', 'opus'].includes(sx) ? sx : 'ogg';
    return { ext, mime: ext === 'webm' ? 'audio/webm' : 'audio/ogg', label: 'Opus', args: ['-c:a', 'libopus', '-b:a', br] };
  }
  if (c === 'vorbis') {
    const ext = sx === 'webm' ? 'webm' : 'ogg';
    return { ext, mime: 'audio/' + ext, label: 'Vorbis', args: ['-c:a', 'libvorbis', '-b:a', br, ...ar] };
  }
  if (c === 'flac') return { ext: 'flac', mime: 'audio/flac', label: 'FLAC', args: ['-c:a', 'flac', ...ar] };
  if (c === 'alac') return { ext: 'm4a', mime: 'audio/mp4', label: 'M4A (ALAC)', args: ['-c:a', 'alac', ...ar] };
  if (c.startsWith('pcm_')) {
    const codec = ['pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'].includes(c) ? c : 'pcm_s16le';
    return { ext: 'wav', mime: 'audio/wav', label: 'WAV', args: ['-c:a', codec, ...ar] };
  }
  return { ext: 'm4a', mime: 'audio/mp4', label: 'M4A (AAC)', args: ['-c:a', 'aac', '-b:a', br, ...ar], fallback: c };
}

$('#aExport').addEventListener('click', async () => {
  if (!abuf) return;
  const f = document.querySelector('input[name=afmt]:checked').value;
  const name = baseName(aname) + '_заслаа';
  if (f === 'orig' && aSrc) {
    const src = aSrc;
    const srcFile = new File([src.blob], src.name, { type: src.blob.type });
    const res = await withBusy('Анхны форматыг шалгаж байна…', async () => {
      const info = aSrcInfo || (aSrcInfo = await probeMedia(srcFile));
      if (!info.acodec) throw new Error('Эх файлаас дуу олдсонгүй.');
      // WebM гэх мэт bitrate-аа заадаггүй файлд хэмжээнээс нь тооцно (зөвхөн дуутай файлд)
      if (!info.abitrate && !info.vcodec && info.duration > 0) {
        info.abitrate = Math.round((srcFile.size * 8) / info.duration / 1000);
      }
      const plan = origAudioPlan(info, src.name, src.blob.type);
      if (undoStack.length === 0) {
        // засвар хийгээгүй: дууны файл бол яг тэр файлыг, видео бол дууны замыг нь дахин кодлохгүй хуулна
        if (!info.vcodec && !plan.fallback) return { same: true };
        const ext = plan.fallback ? 'mka' : plan.ext;
        const data = await runSteps(srcFile, [{ args: ['-i', 'IN', '-vn', '-map', '0:a:0', '-c:a', 'copy', 'out.' + ext], output: 'out.' + ext }], 'Дууг хуулж байна…');
        return { data, plan: { ...plan, ext, mime: plan.fallback ? 'audio/x-matroska' : plan.mime }, copied: true };
      }
      const wav = encodeWav(abuf);
      const data = await runSteps(new File([wav], 'in.wav'), [{ args: ['-i', 'IN', ...plan.args, 'out.' + plan.ext], output: 'out.' + plan.ext }], `${plan.label} болгож байна…`);
      return { data, plan };
    });
    if (!res) return;
    if (res.same) {
      const ext = safeExt(src.name, '');
      download(src.blob, ext ? src.name : src.name + '.' + ((/\/(\w+)/.exec(src.blob.type) || [])[1] || 'webm'));
      return toast('Засвар хийгээгүй тул эх файлыг яг тэр чигээр нь татлаа');
    }
    download(new Blob([res.data.buffer], { type: res.plan.mime }), (res.copied ? baseName(aname) + '_дуу' : name) + '.' + res.plan.ext);
    return toast(res.plan.fallback
      ? `Анхны формат (${res.plan.fallback}) дэмжигдэхгүй тул ${res.plan.label} болгож хадгаллаа`
      : `${res.plan.label} хэлбэрээр татаж авч байна`);
  }
  const wav = encodeWav(abuf);
  if (f === 'wav') {
    download(new Blob([wav], { type: 'audio/wav' }), name + '.wav');
    return toast('Татаж авч байна');
  }
  const data = await withBusy(LOADING_ENGINE, () =>
    runSteps(new File([wav], 'in.wav'), [{ args: ['-i', 'IN', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'], output: 'out.mp3' }], 'MP3 болгож байна…')
  );
  if (data) {
    download(new Blob([data.buffer], { type: 'audio/mpeg' }), name + '.mp3');
    toast('Татаж авч байна');
  }
});

/* ------------------------------------------------------------------ */
/* Файл чирж оруулах (компьютер)                                       */
/* ------------------------------------------------------------------ */
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.querySelectorAll('.hero:not([hidden])').forEach((h) => h.classList.add('drag'));
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.querySelectorAll('.hero').forEach((h) => h.classList.remove('drag'));
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.querySelectorAll('.hero').forEach((h) => h.classList.remove('drag'));
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (!f) return;
  if (f.type.startsWith('audio/')) {
    showTab('audio');
    await loadAudioBlob(f, f.name);
  } else if (f.type.startsWith('video/') || /\.(mkv|mov|mp4|webm|avi)$/i.test(f.name)) {
    // дуу засагч дээр байвал видеоны дууг, эс бөгөөс видеог нээнэ
    if (!$('#tab-audio').hidden) await loadAudioBlob(f, f.name);
    else loadVideo(f);
  } else {
    toast('Видео эсвэл дууны файл оруулна уу.', true);
  }
});

updateAudioView();
updateAudioUI();
