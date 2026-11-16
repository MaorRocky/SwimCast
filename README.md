# SwimCast

A desktop app (Electron) that brings in the podcasts you follow — from Apple Podcasts, an iPhone Shortcut, an iPhone backup, OPML, or search — and downloads episodes as MP3 files you can copy straight onto swim headphones.

## Swim audio

Swim headphones can't change playback speed or go very loud, so SwimCast bakes both into the MP3 when it downloads (both on by default, in Settings):

- **Speed up**: 1.5× to 2.0× in 5% steps, pitch preserved (ffmpeg `atempo`). Default speed is in Settings; each podcast can override it on its page.
- **Volume boost**: gentle compression, then loudness normalization to -12 LUFS with a -1.5 dBTP true-peak limit (most podcasts are mastered at -16 to -19 LUFS).

## Develop

```bash
npm install
npm start
```

## Build (Windows)

```bash
npm install
npm run pack   # unpacked app in dist/win-unpacked/SwimCast.exe
npm run dist   # same, as a zip
```

## Layout

- `src/main/` — Electron main process: feeds, library store, downloads (with ffmpeg MP3 conversion), Apple Podcasts import, copying to the headphones' drive.
- `src/renderer/` — UI (plain JS, no framework).
