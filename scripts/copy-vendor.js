// Copies the ffmpeg.wasm browser bundle from node_modules into public/vendor.
// Runs as the Vercel build step (and before `npm run dev`), so the 32MB wasm file never lives in git.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
const nm = (p) => path.join(root, 'node_modules', p);

const files = [
  [nm('@ffmpeg/ffmpeg/dist/umd'), ['ffmpeg.js', '814.ffmpeg.js']],
  [nm('@ffmpeg/util/dist/umd'), ['index.js']],
  [nm('@ffmpeg/core/dist/umd'), ['ffmpeg-core.js', 'ffmpeg-core.wasm']],
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [dir, names] of files) {
  for (const name of names) {
    fs.copyFileSync(path.join(dir, name), path.join(out, name));
  }
}
console.log('ffmpeg bundle copied to public/vendor');
