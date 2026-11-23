# Video & Voice Editor

A small browser-based editor. **Everything runs client-side** — files are never uploaded anywhere.

**Video tab**
- **Crop both sides** – keep only the part between start and end.
- **Cut the middle** – remove the part between start and end and join the rest.
- **Extract audio only** – MP3, WAV or M4A (and send it straight to the voice editor).
- **Remove audio** – mute a video without re-encoding.

**Voice / Audio tab**
- Open an audio (or video) file, or **record from the microphone**.
- Waveform with drag-to-select; play, trim to selection, delete selection, silence selection,
  auto-trim silence at the ends, volume (dB), normalize, fade in/out, undo.
- Export WAV or MP3.

Built with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (video + MP3) and the Web Audio API.
No framework, no bundler.

## Run locally

```bash
npm install
npm run dev        # builds public/vendor and serves http://localhost:5199
```

## Deploy on Vercel

1. Import this GitHub repo in Vercel.
2. Keep the defaults — `vercel.json` already sets
   Install `npm install`, Build `npm run build`, Output `public`.

The build step copies the ffmpeg.wasm bundle (≈32 MB) from `node_modules` into `public/vendor`,
so it is not stored in git.

## Notes

- Files are processed in browser memory; keep videos to a few hundred MB.
- Re-encoded exports are MP4 (H.264 + AAC). "Fast export" and "Remove audio" keep the original
  codecs, so the output stays in the source container (e.g. `.webm` stays `.webm`) and cuts snap to keyframes.
- Microphone recording needs https or `localhost` (Vercel serves https).
