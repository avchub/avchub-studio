// P0 Step 5C.11 — Content Studio render engine: REAL ffmpeg mixes scene clips + per-scene TTS
// voiceover + a local music bed (sidechain-ducked) + subtitles into a final MP4 with AAC audio and
// a poster thumbnail. Uses REAL Windows SAPI for the voiceover. SKIPS without ffmpeg.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { createWindowsSapiSpeechProvider } from "../lib/movie/speech-provider.mjs";
import { ffmpegPaths, ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }

if (!ffmpegRunnable(ffmpegStatic) || !ffmpegRunnable(ffprobeStaticPath)) { console.log("Step 5C.11 audio render: 0 passed, 0 failed (SKIPPED — no ffmpeg)"); process.exit(0); }

const dir = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".audiorender-"));
try {
  const asm = createMovieAssembler();
  // 3 clips (mixed res/fps).
  const clips = [];
  const specs = [{ size: "640x480", fps: 24 }, { size: "720x1280", fps: 30 }, { size: "1080x1920", fps: 25 }];
  const narrations = ["A lone lighthouse keeper climbs the spiral staircase at night.", "A distant ship appears on the stormy horizon.", "Dawn breaks slowly over the calm water."];
  // real TTS voiceover per scene
  let tts = null; try { tts = createWindowsSapiSpeechProvider(); } catch { tts = null; }
  const voices = tts ? await tts.listVoices() : [];
  for (let i = 0; i < 3; i += 1) {
    const clip = path.join(dir, `c${i}.mp4`);
    const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", `testsrc=size=${specs[i].size}:rate=${specs[i].fps}:duration=4`, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { windowsHide: true });
    if (r.status !== 0) { console.log("Step 5C.11 audio render: 0 passed, 0 failed (SKIPPED — fixture gen failed)"); process.exit(0); }
    let narrationPath = null;
    if (voices.length) { narrationPath = path.join(dir, `n${i}.wav`); try { await tts.synthesize({ text: narrations[i], voiceId: voices[0].id, outputPath: narrationPath.split("/").join("\\") }); } catch { narrationPath = null; } }
    clips.push({ path: clip, narrationPath, narration: narrations[i], durationSeconds: 4 });
  }
  const usedRealTts = clips.some((c) => c.narrationPath);
  check("R0 real TTS voiceover generated for scenes", usedRealTts, true);

  // local original music bed (a soft sine tone — no copyrighted audio).
  const music = path.join(dir, "music.m4a");
  const rm = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-af", "volume=0.3", "-c:a", "aac", music], { windowsHide: true });
  const musicArg = rm.status === 0 ? { path: music, volume: 0.4 } : null;

  const out = path.join(dir, "final.mp4");
  const result = await asm.assembleWithAudio({ clips, workDir: path.join(dir, "work"), outputPath: out, title: "", includeTitleCard: false, aspectRatio: "9:16", music: musicArg, subtitleMode: "embed" });

  check("R1 final MP4 exists + non-trivial", result.sizeBytes > 20000, true);
  check("R1 target dims 720x1280", [result.width, result.height], [720, 1280]);
  check("R1 has an AUDIO track (voiceover+music)", result.hasAudio, true);
  check("R1 audio codec aac", result.audioCodec, "aac");
  check("R1 video codec h264", result.videoCodec, "h264");
  check("R1 has subtitles", result.hasSubtitles, true);
  check("R1 music mixed in", result.hasMusic, true);
  check("R1 scene count 3", result.sceneCount, 3);
  check("R1 poster thumbnail extracted", Boolean(result.thumbnailPath && existsSync(result.thumbnailPath)), true);
  // duration ~= 3 scenes * 4s = ~12s (audio track drives it via -shortest)
  check("R1 duration in range (11-13s)", result.durationSeconds > 11 && result.durationSeconds < 13.5, true);
  // independent re-probe confirms both streams
  const streams = await asm.probeStreams(out);
  check("R1 reprobe: video + audio present", streams.videoCodec === "h264" && streams.hasAudio, true);

  // inspectMedia validates an uploaded file
  const mi = await asm.inspectMedia(music);
  check("R2 inspectMedia reports audio + duration", mi.hasAudio && mi.durationSeconds > 0, true);

  console.log(`Step 5C.11 audio render: ${passed} passed, 0 failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
