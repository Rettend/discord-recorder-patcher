# Discord Recorder Patcher

From: <https://soham.sh/blog/read?title=discord-rec>

Reapplies the direct-stream recorder injection to Discord's `discord_voice/index.js` on Windows.

This is useful after Discord updates overwrite the patched module.

## What it does

- Finds your latest `app-*` Discord install under `%LOCALAPPDATA%\Discord`.
- Locates `modules\discord_voice-*\discord_voice\index.js`.
- Applies the recorder injection (imports, recorder implementation, direct sink hooks).
- Creates a timestamped backup before writing.

## Prerequisites

- Discord must be fully closed.
- `ffmpeg` must be installed and available on `PATH` (or set `DISCORD_REC_FFMPEG`).

Install ffmpeg on Windows:

```powershell
winget install --id Gyan.FFmpeg.Essentials -e
```

## Usage

From this folder:

```powershell
bun run status
bun run apply
bun run status
```

To restore latest backup:

```powershell
bun run restore
```

To restore a specific backup:

```powershell
bun run restore -- "C:\path\to\index.js.bak.recorder.20260305_120000"
```

## Optional environment variables

Patcher target resolution:

- `DISCORD_VOICE_INDEX` - explicit path to `index.js`.
- `DISCORD_ROOT` - explicit Discord root (instead of `%LOCALAPPDATA%\Discord`).

Recorder runtime options (used by the injected code):

- `DISCORD_REC_DIR` - output directory (default: `%USERPROFILE%\discord-recs`).
- `DISCORD_REC_EXT` - file extension (default: `mp4`).
- `DISCORD_REC_FPS` - ffmpeg input FPS (default: `30`).
- `DISCORD_REC_FFMPEG` - ffmpeg binary path (default: `ffmpeg`).
