// P0 Step 5C.39 — turn a clip into something a judge can look at.
//
// Five frames across the shot, stacked into one labelled sheet. Five because a single frame cannot show whether
// an action HAPPENS — a man reaching for a letter and a man who never touches it look identical at one instant —
// and because sending a video would be slower, larger, and no more informative for the question being asked.
//
// The timestamps are burned into the image, not merely passed alongside it. The judge is required to cite a
// frame for every claim, and a citation is only checkable if the model can see which frame it is looking at.
// That single detail is what separates evidence from a plausible-sounding paragraph.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ffmpegPaths } from "../media/ffmpeg-locator.mjs";
import { escapeFilterPath, escapeFilterText } from "../media/ffmpeg-filter.mjs";

// FFmpeg is GPL and is NOT bundled: the operator installs it and this resolves where it landed.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const FFMPEG = ffmpegStatic;
const FFPROBE = ffprobeStaticPath;

function err(code, message) { return Object.assign(new Error(message), { code }); }

/** A font drawtext can actually load. Without an explicit fontfile the filter draws NOTHING on Windows — the
 *  bar appears, the text does not, and the sheet looks fine until you notice every frame is unlabelled and the
 *  judge has nothing to cite. Verified by looking at the output, which is the only way this is catchable. */
function firstFont() {
  for (const f of ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/calibri.ttf", "C:/Windows/Fonts/tahoma.ttf"]) {
    if (existsSync(f)) return f;
  }
  return null;
}

function run(bin, args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "", errText = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish({ code: -1, out, err: "timeout" }); }, timeoutMs);
    if (typeof t.unref === "function") t.unref();
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.on("error", () => finish({ code: -1, out, err: "spawn" }));
    child.on("close", (code) => finish({ code, out, err: errText }));
  });
}

/** Where to sample. Never at 0.0 or exactly at the end: the first and last frames of a generated clip are the
 *  most likely to be a fade, a black frame or an encoder artefact, and grading those would judge the encoder
 *  rather than the content. */
export function sampleTimesFor(durationSeconds, count = 5) {
  const d = Number(durationSeconds);
  if (!Number.isFinite(d) || d <= 0.2) return [];
  const first = Math.min(0.35, d * 0.08);
  const last = Math.max(first, d - Math.min(0.35, d * 0.08));
  if (count <= 1) return [Number(((first + last) / 2).toFixed(3))];
  const span = last - first;
  return Array.from({ length: count }, (_, i) => Number((first + (span * i) / (count - 1)).toFixed(3)));
}

export async function probeDuration(file) {
  if (!FFPROBE) throw err("E_FFPROBE_MISSING", "ffprobe is required");
  const r = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { timeoutMs: 30_000 });
  if (r.code !== 0) throw err("E_CLIP_UNREADABLE", "the clip could not be probed");
  try { const j = JSON.parse(r.out); const d = Number(j.format?.duration); return Number.isFinite(d) ? d : null; }
  catch { return null; }
}

/**
 * Build the sheet.
 *
 * One ffmpeg invocation per frame, then a tile. Doing it in a single filtergraph would be faster and far more
 * fragile: a graph that fails produces no sheet and no clue which frame was the problem, and a clip whose
 * duration is slightly shorter than probed would take the whole thing down rather than one sample.
 */
export async function buildContactSheet({ clipPath, outputPath, workDir, count = 5, columns = 1, frameWidth = 360, label = true } = {}) {
  if (!FFMPEG) throw err("E_FFMPEG_MISSING", "ffmpeg is required");
  if (!clipPath || !existsSync(clipPath)) throw err("E_CLIP_MISSING", "the clip file is missing");

  const duration = await probeDuration(clipPath);
  if (!Number.isFinite(duration) || duration <= 0) throw err("E_CLIP_UNREADABLE", "the clip has no usable duration");

  const times = sampleTimesFor(duration, count);
  if (times.length === 0) throw err("E_CLIP_TOO_SHORT", "the clip is too short to sample");

  const dir = workDir || path.join(path.dirname(outputPath), ".sheet");
  await mkdir(dir, { recursive: true });

  const frames = [];
  const files = [];
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    const pct = Math.round((t / duration) * 100);
    const out = path.join(dir, `f${String(i).padStart(2, "0")}.jpg`);
    // drawtext needs an escaped colon; the label carries both the absolute time and the position in the shot,
    // because "2.4s" and "halfway through" answer different questions a judge might have.
    // No '%' in the label. drawtext treats % as a format specifier, so "6%" makes the ENTIRE text expand to
    // nothing — and ffmpeg reports "Stray %" on stderr while still exiting 0, so the frame is produced, the
    // box is drawn, and the label is simply absent. expansion=none below stops any interpretation; keeping the
    // text free of % as well means the label survives even if that option is ever dropped.
    const text = `${t.toFixed(2)}s  (${pct} pct)`;
    const font = firstFont();
    const vf = [
      `scale=${frameWidth}:-2`,
      label ? `drawbox=x=0:y=0:w=iw:h=30:color=black@0.7:t=fill` : null,
      // The COLON in a Windows drive letter has to be escaped as well. ffmpeg splits filter options on ':'
      // even inside single quotes, so fontfile='C:/Windows/...' silently truncates to 'C' — the filter still
      // succeeds, the box is drawn, and the text is simply absent. It looks like a working sheet until you
      // open it and find every frame unlabelled and therefore uncitable. The colon was handled here from the
      // start; backslash and quote were not, which is the same failure by a different character.
      label && font ? `drawtext=expansion=none:fontfile='${escapeFilterPath(font)}':text='${escapeFilterText(text)}':x=10:y=6:fontsize=20:fontcolor=white` : null
    ].filter(Boolean).join(",");
    if (label && !font) throw err("E_SHEET_NO_FONT", "no font is available to label the frames, and unlabelled frames cannot be cited");
    const r = await run(FFMPEG, ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", clipPath, "-frames:v", "1", "-vf", vf, "-q:v", "3", out], { timeoutMs: 60_000 });
    // A single unreadable sample is not fatal — four labelled frames still answer the question, and the sheet
    // records how many it actually contains so nobody assumes five.
    if (r.code === 0 && existsSync(out)) { files.push(out); frames.push({ index: frames.length, label: `frame ${frames.length + 1}`, atSeconds: t, percent: pct }); }
  }
  if (files.length === 0) throw err("E_FRAMES_UNREADABLE", "no frame could be decoded from the clip");

  const rows = Math.ceil(files.length / columns);
  const inputs = files.flatMap((f) => ["-i", f]);
  const chain = files.map((_, i) => `[${i}:v]`).join("");
  // vstack for one column, hstack for one row, xstack otherwise. The general xstack layout expression was
  // wrong for a single column and ffmpeg answered by emitting ONE frame instead of five — a malformed layout
  // does not fail loudly, it just quietly produces less than you asked for.
  const filter = columns === 1
    ? `${chain}vstack=inputs=${files.length}[v]`
    : files.length === columns
      ? `${chain}hstack=inputs=${files.length}[v]`
      : `${chain}xstack=inputs=${files.length}:layout=${files.map((_, i) => `${i % columns}_${Math.floor(i / columns)}`).join("|")}[v]`;
  const r = await run(FFMPEG, ["-v", "error", "-y", ...inputs, "-filter_complex", filter,
    "-map", "[v]", "-frames:v", "1", "-q:v", "3", outputPath], { timeoutMs: 90_000 });
  if (r.code !== 0 || !existsSync(outputPath)) throw err("E_SHEET_BUILD_FAILED", `the contact sheet could not be assembled: ${String(r.err).slice(-160)}`);

  const bytes = await readFile(outputPath);
  try { await rm(dir, { recursive: true, force: true }); } catch { /* the sheet is what matters */ }

  return Object.freeze({
    path: outputPath,
    sizeBytes: bytes.length,
    base64: bytes.toString("base64"),
    mimeType: "image/jpeg",
    frames: Object.freeze(frames),
    clipDurationSeconds: Number(duration.toFixed(3)),
    rows, columns
  });
}

/** Save a sheet's bytes without re-rendering — used by the UI's "inspect sampled frames". */
export async function writeSheet(base64, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(base64, "base64"));
  return outputPath;
}
