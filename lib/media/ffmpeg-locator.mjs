// Where FFmpeg is, without shipping it.
//
// FFmpeg is GPL. Bundling the binary would put this project's distribution under obligations it is not set up
// to meet, so the operator installs FFmpeg and this module finds it. Resolution order:
//
//   1. FFMPEG_PATH / FFPROBE_PATH   — explicit, wins over everything
//   2. the `ffmpeg-static` / `ffprobe-static` packages, IF an installation chose to add them itself
//   3. `ffmpeg` / `ffprobe` on PATH
//
// A miss is a hard, named error with the install instruction in it. Silently degrading to "no video output"
// is the failure mode this ordering exists to prevent.

import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// Resolved synchronously, because most call sites take the paths as default parameter values and cannot await.
// An installation that adds ffmpeg-static itself keeps working exactly as before; one that does not falls
// through to PATH.
function fromOptionalPackageSync(name) {
  try {
    const value = require(name);
    const resolved = typeof value === "string" ? value : value?.path;
    return typeof resolved === "string" && resolved.length ? resolved : null;
  } catch { return null; }
}

export const FFMPEG_ERRORS = Object.freeze({
  NOT_FOUND: "E_FFMPEG_NOT_FOUND",
  NOT_EXECUTABLE: "E_FFMPEG_NOT_EXECUTABLE"
});

const INSTALL_HINT = "install FFmpeg (https://ffmpeg.org/download.html) and put ffmpeg/ffprobe on PATH, or set FFMPEG_PATH and FFPROBE_PATH";

function err(code, message, detail = {}) { return Object.assign(new Error(message), { code, detail }); }


async function usable(binary) {
  try { await run(binary, ["-version"], { timeout: 10_000 }); return true; }
  catch { return false; }
}

let cached = null;

/**
 * Resolve both binaries once per process.
 *
 * `refresh: true` re-resolves, which matters in tests that change the environment; everything else takes the
 * cache, because probing two binaries on every scene render is wasted work.
 */
export async function resolveFfmpeg({ env = process.env, refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const ffmpeg = env.FFMPEG_PATH || fromOptionalPackageSync("ffmpeg-static") || "ffmpeg";
  const ffprobe = env.FFPROBE_PATH || fromOptionalPackageSync("ffprobe-static") || "ffprobe";

  for (const [label, binary] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
    if (!(await usable(binary))) {
      throw err(FFMPEG_ERRORS.NOT_FOUND, `${label} was not found or would not run (${binary}) — ${INSTALL_HINT}`, { label, binary });
    }
  }

  cached = Object.freeze({ ffmpeg, ffprobe });
  return cached;
}

/** The paths without probing — for call sites that only need to spawn and will surface their own failure. */
export function ffmpegPaths(env = process.env) {
  return Object.freeze({
    ffmpeg: env.FFMPEG_PATH || fromOptionalPackageSync("ffmpeg-static") || "ffmpeg",
    ffprobe: env.FFPROBE_PATH || fromOptionalPackageSync("ffprobe-static") || "ffprobe"
  });
}

/**
 * Does this binary actually run? Synchronous, for callers that must decide before anything async — a test
 * deciding whether to skip, or a health snapshot building a plain object.
 *
 * The reason this exists at all: `existsSync(binary)` is the wrong question when the binary came from
 * resolution step 3, which returns the bare command name "ffmpeg" for PATH to resolve. `existsSync("ffmpeg")`
 * asks whether a file called "ffmpeg" sits in the CURRENT DIRECTORY, so it answers false on every normal
 * PATH installation. Six test suites and the ops snapshot had that guard, which meant they reported "no
 * ffmpeg" on exactly the installations FFmpeg was working on — including CI, which installs it on purpose.
 *
 * An absolute path can be rejected cheaply without spawning; anything else has to be executed to know.
 */
export function ffmpegRunnable(binary, { probeArgs = ["-version"] } = {}) {
  if (!binary) return false;
  if (path.isAbsolute(binary) && !existsSync(binary)) return false;
  const probe = spawnSync(binary, probeArgs, { windowsHide: true, timeout: 10_000 });
  return probe.status === 0;
}

/** Test seam: forget what was resolved. */
export function resetFfmpegCache() { cached = null; }
