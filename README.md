# SwimCast

A desktop app (Electron) that brings in the podcasts you follow — from Apple Podcasts, an iPhone Shortcut, an iPhone backup, OPML, or search — and downloads episodes as MP3 files you can copy straight onto swim headphones.

## Develop

```bash
npm install
npm start
```

## Build (Windows)

```bash
npm install --save-dev electron-builder
npm run dist
```

## Layout

- `src/main/` — Electron main process: feeds, library store, downloads (with ffmpeg MP3 conversion), Apple Podcasts import, copying to the headphones' drive.
- `src/renderer/` — UI (plain JS, no framework).
