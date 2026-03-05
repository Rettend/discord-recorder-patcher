const activeRecorders = new Map();

function trace(event, data) {
  let suffix = '';
  if (data != null) {
    try {
      suffix = ` ${JSON.stringify(data)}`;
    } catch (_e) {
      suffix = ' {"serializeError":true}';
    }
  }
  log('info', `[recorder] ${event}${suffix}`);
}

function randomToken(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getRecordingDir() {
  return process.env.DISCORD_REC_DIR || path.join(os.homedir(), 'discord-recs');
}

function getRecordingPath(streamId) {
  const ts = Math.floor(Date.now() / 1000);
  const token = randomToken(5);
  const ext = process.env.DISCORD_REC_EXT || 'mp4';
  return path.join(getRecordingDir(), `${ts}-${token}-stream${streamId}.${ext}`);
}

function waitForDrain(stream) {
  return new Promise((resolve) => stream.once('drain', resolve));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logRecorderStderr(state, chunk) {
  const now = Date.now();
  if (now - state.lastStderrLogAt < 2000) {
    state.droppedStderrChunks += 1;
    return;
  }

  state.lastStderrLogAt = now;
  trace('recorder_ffmpeg_stderr', {
    streamId: state.streamId,
    outputPath: state.outputPath,
    droppedChunks: state.droppedStderrChunks,
    stderr: String(chunk).trim().slice(0, 800),
  });
  state.droppedStderrChunks = 0;
}

function stopRecorderProcess(state, reason) {
  const proc = state.ffmpeg;
  if (proc == null) return;

  state.ffmpeg = null;

  if (!proc.stdin.destroyed) proc.stdin.end();

  if (proc._recKillTimer != null) clearTimeout(proc._recKillTimer);
  proc._recKillTimer = setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL');
  }, 3000);

  proc.once('exit', () => {
    if (proc._recKillTimer != null) {
      clearTimeout(proc._recKillTimer);
      proc._recKillTimer = null;
    }
  });

  trace('recorder_process_stop', {
    streamId: state.streamId,
    outputPath: state.outputPath,
    reason,
  });
}

function startRecorderProcess(state, width, height) {
  const outputPath = getRecordingPath(state.streamId);
  const ffmpegBin = process.env.DISCORD_REC_FFMPEG || 'ffmpeg';
  const fps = String(process.env.DISCORD_REC_FPS || 30);
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', fps,
    '-i', '-',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ];

  state.outputPath = outputPath;
  state.width = width;
  state.height = height;
  state.lastStderrLogAt = 0;
  state.droppedStderrChunks = 0;

  const proc = childProcess.spawn(ffmpegBin, args, {stdio: ['pipe', 'ignore', 'pipe']});
  state.ffmpeg = proc;

  proc.on('error', (err) => {
    trace('recorder_ffmpeg_error', {
      streamId: state.streamId,
      ffmpegBin,
      error: err?.message ?? String(err),
    });
  });

  if (proc.stderr != null) {
    proc.stderr.on('data', (chunk) => logRecorderStderr(state, chunk));
  }

  proc.on('exit', (code, signal) => {
    if (proc._recKillTimer != null) {
      clearTimeout(proc._recKillTimer);
      proc._recKillTimer = null;
    }
    if (state.ffmpeg === proc) state.ffmpeg = null;
    trace('recorder_ffmpeg_exit', {
      streamId: state.streamId,
      outputPath: state.outputPath,
      code,
      signal,
    });
  });

  trace('recorder_started', {
    streamId: state.streamId,
    outputPath: state.outputPath,
    ffmpegBin,
    width,
    height,
    fps,
  });
}

async function startRecorder(streamId) {
  if (activeRecorders.has(streamId)) return;

  const state = {
    streamId,
    running: true,
    ffmpeg: null,
    outputPath: null,
    width: null,
    height: null,
    lastStderrLogAt: 0,
    droppedStderrChunks: 0,
  };

  activeRecorders.set(streamId, state);
  fs.mkdirSync(getRecordingDir(), {recursive: true});

  trace('recorder_loop_start', {
    streamId,
    recordingDir: getRecordingDir(),
  });

  while (state.running) {
    try {
      const frame = await VoiceEngine.getNextVideoOutputFrame(streamId);
      if (!state.running) break;

      if (state.ffmpeg == null) {
        startRecorderProcess(state, frame.width, frame.height);
      } else if (frame.width !== state.width || frame.height !== state.height) {
        trace('recorder_resolution_change', {
          streamId,
          from: `${state.width}x${state.height}`,
          to: `${frame.width}x${frame.height}`,
        });
        stopRecorderProcess(state, 'resolution_change');
        startRecorderProcess(state, frame.width, frame.height);
      }

      const proc = state.ffmpeg;
      if (proc == null || proc.killed || proc.stdin.destroyed) {
        await wait(100);
        continue;
      }

      const frameBuffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      const wrote = proc.stdin.write(frameBuffer);
      if (!wrote) await waitForDrain(proc.stdin);
    } catch (e) {
      trace('recorder_frame_error', {
        streamId,
        error: e?.message ?? String(e),
      });
      await wait(150);
    }
  }

  stopRecorderProcess(state, 'loop_end');
  activeRecorders.delete(streamId);
  trace('recorder_loop_end', {
    streamId,
    outputPath: state.outputPath,
  });
}

function stopRecorder(streamId) {
  const state = activeRecorders.get(streamId);
  if (state == null) return;

  state.running = false;
  stopRecorderProcess(state, 'stop_requested');

  trace('recorder_stop_requested', {
    streamId,
    outputPath: state.outputPath,
  });
}
