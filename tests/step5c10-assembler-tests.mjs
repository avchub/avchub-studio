// P0 Step 5C.10 — movie assembler: REAL ffmpeg normalizes clips of differing resolution/fps and
// concatenates them into one valid MP4 with the target dimensions + a subtitle track. SKIPS if the
// ffmpeg binaries are unavailable.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createMovieAssembler, buildSrt } from "../lib/movie/movie-assembler.mjs";
import { ffmpegPaths, ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }

// Whether the binaries RUN, not whether a file of that name sits in the working directory. This guard used
// to be `existsSync(ffmpegStatic)`, which is false for every PATH installation — see ffmpegRunnable.
if (!ffmpegRunnable(ffmpegStatic) || !ffmpegRunnable(ffprobeStaticPath)) {
  console.log("Step 5C.10 assembler: 0 passed, 0 failed (SKIPPED — no ffmpeg)");
  process.exit(0);
}

// pure buildSrt first
{
  const srt = buildSrt([{ durationSeconds: 6, narration: "First scene" }, { durationSeconds: 4, narration: "Second scene" }]);
  // Match the whole SubRip timing line, not a bare "-->". Counting the arrow alone also counts one that
  // appears inside narration text, so the assertion was weaker than it looked; anchoring it to the
  // timestamp grammar is what "two cues" actually means.
  check("S1 srt has two cues", (srt.match(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/gm) || []).length, 2);
  check("S1 srt timing is cumulative", srt.includes("00:00:06,000 --> 00:00:10,000"), true);
  check("S1 srt carries narration", srt.includes("First scene") && srt.includes("Second scene"), true);
  check("S1 empty narration produces no cue", buildSrt([{ durationSeconds: 5, narration: "" }]).trim(), "");
}

const dir = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".asm-test-"));
try {
  // Make 3 fake clips with DIFFERENT resolutions + fps + durations (testcard source).
  const specs = [
    { name: "a.mp4", size: "640x480", fps: 24, d: 2 },
    { name: "b.mp4", size: "720x1280", fps: 30, d: 2 },
    { name: "c.mp4", size: "1080x1920", fps: 25, d: 2 }
  ];
  const clips = [];
  for (const s of specs) {
    const p = path.join(dir, s.name);
    const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", `testsrc=size=${s.size}:rate=${s.fps}:duration=${s.d}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", p], { windowsHide: true });
    if (r.status !== 0) { console.log("Step 5C.10 assembler: 0 passed, 0 failed (SKIPPED — fixture gen failed)"); process.exit(0); }
    clips.push({ path: p, narration: `Scene for ${s.name}`, durationSeconds: s.d });
  }

  const asm = createMovieAssembler();
  const out = path.join(dir, "movie.mp4");
  const result = await asm.assemble({ clips, workDir: path.join(dir, "work"), outputPath: out, title: "Test Movie", aspectRatio: "9:16" });

  check("A1 final MP4 exists + non-trivial size", result.sizeBytes > 10000, true);
  check("A1 target dimensions 720x1280 (9:16)", [result.width, result.height], [720, 1280]);
  check("A1 scene count recorded", result.sceneCount, 3);
  check("A1 has subtitles", result.hasSubtitles, true);
  check("A1 sidecar srt written", existsSync(result.srtPath), true);
  // duration ~= title(1.5) + 3*2 = ~7.5s (allow tolerance for keyframe/encode rounding)
  check("A1 duration in expected range (6.5-9.5s)", result.durationSeconds > 6.5 && result.durationSeconds < 9.5, true);
  // the muxed output must actually be a playable mp4 the probe can read back
  const reprobe = await asm.probe(out);
  check("A1 reprobe reads a valid stream", reprobe.width === 720 && reprobe.height === 1280, true);

  // missing clip rejects
  let threw = false;
  try { await asm.assemble({ clips: [{ path: path.join(dir, "nope.mp4") }], workDir: path.join(dir, "w2"), outputPath: path.join(dir, "x.mp4"), title: "x" }); } catch (e) { threw = e.code === "E_ASSEMBLE_CLIP_MISSING"; }
  check("A2 missing clip rejects", threw, true);

  console.log(`Step 5C.10 assembler: ${passed} passed, 0 failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
