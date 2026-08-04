// P0 Step 5C.10 — deterministic local movie assembly with FFmpeg (ffmpeg-static / ffprobe-static).
//
// Normalizes each scene clip to a single target resolution / fps / codec / pixel format (so clips
// from different generations concat cleanly regardless of their source codec/resolution/fps), adds
// a short opening title card + a gentle fade transition per scene, concatenates in scene order,
// builds an SRT subtitle track from each scene's narration, and muxes a final MP4. No network, no
// secrets; inputs/outputs are Worker-local files under the owner tree. Pure ffmpeg, injectable so
// tests can stub the binaries.

import { spawn } from "node:child_process";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function err(code, message) { return Object.assign(new Error(message), { code }); }

// P0 Step 5C.39 — 24, matching the native Grok source and the master profile. At 30 the normaliser
// duplicates five frames a second: no extra motion, just judder where a clean cadence was, and bitrate spent
// encoding frames that carry nothing. Master and renderer must agree, or every render fails its own gate.
export const DEFAULT_FPS = 24;
export function dimsFor(aspectRatio) {
  switch (aspectRatio) {
    case "16:9": return { width: 1280, height: 720 };
    case "1:1": return { width: 1024, height: 1024 };
    case "2:3": return { width: 720, height: 1080 };
    case "3:2": return { width: 1080, height: 720 };
    case "9:16": default: return { width: 720, height: 1280 };
  }
}

function run(bin, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "", errText = "", done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(t); fn(arg); };
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } finish(reject, err("E_FFMPEG_TIMEOUT", `${path.basename(bin)} timed out`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    child.on("error", (e) => finish(reject, e));
    child.on("close", (code) => (code === 0 ? finish(resolve, { out, err: errText }) : finish(reject, err("E_FFMPEG_FAILED", `${path.basename(bin)} exited ${code}: ${(errText || out).slice(-400)}`))));
  });
}

function firstFont() {
  for (const f of ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/calibri.ttf"]) if (existsSync(f)) return f;
  return null;
}
function ffEscapeText(s) { return String(s || "").replace(/[\\:']/g, " ").replace(/[^ -~]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80); }

// buildSrt lives in the pure subtitles module (5C.11) so the control-plane facade can use it
// without importing this ffmpeg-binding module; re-exported here to keep the 5C.10 API intact.
import { buildSrt } from "./subtitles.mjs";
import { ffmpegPaths } from "../media/ffmpeg-locator.mjs";
import { escapeFilterPath } from "../media/ffmpeg-filter.mjs";

// FFmpeg is GPL and is NOT bundled: the operator installs it and this resolves where it landed.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();
export { buildSrt };

export function createMovieAssembler({ ffmpegPath = ffmpegStatic, ffprobePath = ffprobeStaticPath, now = () => Date.now() } = {}) {
  if (!ffmpegPath || !ffprobePath) throw err("E_FFMPEG_MISSING", "ffmpeg/ffprobe binaries are required");

  async function probe(file) {
    const { out } = await run(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file], { timeoutMs: 30_000 });
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    const [nfr, dfr] = String(s.r_frame_rate || "0/1").split("/").map(Number);
    return { width: s.width || null, height: s.height || null, fps: dfr ? nfr / dfr : null, durationSeconds: j.format && j.format.duration ? Number(j.format.duration) : null };
  }

  // 5C.11: optional per-clip trim (trimIn/trimOut, seconds within the source clip) + per-clip fade
  // seconds (transition). fadeSeconds=0 → hard cut. Defaults preserve the certified 5C.10 behavior.
  async function normalizeClip(input, output, { width, height, fps, fadeSeconds = 0.3, trimIn = null, trimOut = null }) {
    const meta = await probe(input).catch(() => ({ durationSeconds: null }));
    const srcDur = Number.isFinite(meta.durationSeconds) && meta.durationSeconds > 0 ? meta.durationSeconds : null;
    const tIn = Number.isFinite(trimIn) && trimIn > 0 ? trimIn : 0;
    let tLen = null;
    if (Number.isFinite(trimOut) && trimOut > tIn) tLen = trimOut - tIn;
    if (srcDur !== null && tIn >= srcDur) { tLen = null; } // out-of-range trim is ignored, not fatal
    const dur = tLen ?? (srcDur !== null ? Math.max(0, srcDur - tIn) : null);
    const fs = Number.isFinite(fadeSeconds) ? Math.max(0, Math.min(3, fadeSeconds)) : 0.3;
    const fade = fs > 0 && dur && dur > fs * 2 + 0.2
      ? `,fade=t=in:st=0:d=${fs},fade=t=out:st=${(dur - fs).toFixed(3)}:d=${fs}` : "";
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p${fade}`;
    const trimArgs = [];
    if (tIn > 0 && (srcDur === null || tIn < srcDur)) trimArgs.push("-ss", tIn.toFixed(3));
    if (tLen !== null) trimArgs.push("-t", tLen.toFixed(3));
    await run(ffmpegPath, ["-y", ...trimArgs, "-i", input, "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-video_track_timescale", "15360", output]);
  }

  // Best-effort title card (a short branded intro). Uses a system font when available; otherwise a
  // plain color card — never fails the whole assembly on a missing font.
  async function titleCard(output, { width, height, fps, title, seconds = 1.5 }) {
    const font = firstFont();
    // The font path needs the SAME treatment as the subtitle path below: firstFont() returns
    // "C:/Windows/Fonts/arial.ttf", and rewriting backslashes alone leaves the drive-letter colon to split
    // the option list, so the card rendered with no text at all and still exited 0.
    const draw = font ? `,drawtext=fontfile='${escapeFilterPath(font)}':text='${ffEscapeText(title)}':fontcolor=white:fontsize=${Math.round(height / 16)}:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,0.3),t/0.3,if(lt(t,${(seconds - 0.3).toFixed(2)}),1,(${seconds}-t)/0.3))'` : "";
    await run(ffmpegPath, ["-y", "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds}`, "-vf", `format=yuv420p${draw}`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-video_track_timescale", "15360", output]);
  }

  // Assemble the final movie. clips: ordered [{ path, narration?, heading?, durationSeconds? }].
  // Returns safe media metadata (relative path is the caller's concern; here we return absolutes +
  // sizes/probe, and a sidecar .srt).
  async function assemble({ clips, workDir, outputPath, title = "", aspectRatio = "9:16", includeTitleCard = true }) {
    if (!Array.isArray(clips) || clips.length === 0) throw err("E_ASSEMBLE_NO_CLIPS", "at least one clip is required");
    for (const c of clips) if (!c || typeof c.path !== "string" || !existsSync(c.path)) throw err("E_ASSEMBLE_CLIP_MISSING", "a scene clip file is missing");
    await mkdir(workDir, { recursive: true });
    const { width, height } = dimsFor(aspectRatio);
    const fps = DEFAULT_FPS;

    const segments = [];
    if (includeTitleCard && title) { const tc = path.join(workDir, "seg_title.mp4"); await titleCard(tc, { width, height, fps, title }); segments.push(tc); }
    for (let i = 0; i < clips.length; i += 1) {
      const seg = path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
      await normalizeClip(clips[i].path, seg, { width, height, fps });
      segments.push(seg);
    }
    // Concat the identically-normalized segments (stream copy is safe: same codec/params/timebase).
    const listFile = path.join(workDir, "concat.txt");
    await writeFile(listFile, segments.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const concatOut = path.join(workDir, "concat.mp4");
    await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", concatOut]);

    // Subtitles from narration, muxed as a soft mov_text track; also written as a sidecar .srt.
    const srt = buildSrt(clips);
    let finalOut = concatOut;
    const srtPath = outputPath.replace(/\.mp4$/i, ".srt");
    await writeFile(srtPath, srt || "1\n00:00:00,000 --> 00:00:01,000\n \n", "utf8");
    if (srt.trim()) {
      try {
        await run(ffmpegPath, ["-y", "-i", concatOut, "-i", srtPath, "-c", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=und", outputPath]);
        finalOut = outputPath;
      } catch { finalOut = concatOut; }
    }
    if (finalOut !== outputPath) { await run(ffmpegPath, ["-y", "-i", concatOut, "-c", "copy", "-movflags", "+faststart", outputPath]); finalOut = outputPath; }

    const meta = await probe(outputPath);
    const info = await stat(outputPath);
    return Object.freeze({
      outputPath, srtPath, sizeBytes: info.size, container: "mp4",
      durationSeconds: meta.durationSeconds, width: meta.width, height: meta.height,
      sceneCount: clips.length, hasSubtitles: Boolean(srt.trim())
    });
  }

  // Build one audio segment exactly `seconds` long: the narration WAV padded/trimmed to the scene
  // duration, or pure silence when a scene has no narration. Encoded to AAC so all segments concat.
  async function audioSegment(narrationPath, seconds, output) {
    const dur = Number.isFinite(seconds) && seconds > 0 ? seconds : 6;
    if (narrationPath && existsSync(narrationPath)) {
      await run(ffmpegPath, ["-y", "-i", narrationPath, "-af", `apad,atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB`, "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", output]);
    } else {
      await run(ffmpegPath, ["-y", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-t", dur.toFixed(3), "-c:a", "aac", "-b:a", "160k", output]);
    }
  }

  // Full Content Studio render: scene clips (normalized + faded) with per-scene voiceover, optional
  // background music (sidechain-ducked under narration + loudnorm), and subtitles (embedded mov_text,
  // optional burn-in), plus a poster thumbnail. Deterministic. clips: ordered
  // [{ path, narrationPath?, narration?, heading?, durationSeconds? }].
  /**
   * P0 Step 5C.47 — one scene's soundtrack, built from what the routing gate decided.
   *
   * Five shapes, and the plan names which:
   *   no plan / USE_ELEVENLABS_ONLY  — narration alone (or silence). The behaviour before this step.
   *   MUTE_GROK_SPEECH_...           — narration alone. The clip's audio is DROPPED, not lowered: a voice at
   *                                    -18 dB is still a second voice, and the whole reason this branch
   *                                    exists is that the clip is saying something else.
   *   KEEP_GROK_AMBIENCE_...         — narration over the clip's audio, ducked under it.
   *   USE_GROK_NARRATION             — the clip's own audio IS the narration; nothing is synthesised.
   *
   * A scene the FILM overrode is handled by its effective flags, so an eligible-but-overridden Grok scene
   * lands in the mute branch rather than quietly keeping its speech.
   */
  async function sceneAudio({ plan, clipPath, narrationPath, seconds, output, workDir, index }) {
    const decision = plan && typeof plan.decision === "string" ? plan.decision : null;
    const keepSource = plan ? (plan.effectiveKeepSourceAudio ?? plan.keepSourceAudio) === true : false;
    const useSourceAsNarration = plan
      ? (plan.effectiveNarrationSource || plan.narrationSource) === "GROK" && plan.sceneActuallySkipped !== false
      : false;

    // The clip's own audio, normalised to the segment's length and the film's rate. Absent or unreadable
    // audio yields silence rather than a failure: a missing track must not lose the scene.
    const sourceTrack = async () => {
      const out = path.join(workDir, `src_${String(index).padStart(3, "0")}.m4a`);
      try {
        await run(ffmpegPath, ["-y", "-i", clipPath, "-map", "0:a:0", "-af", `apad,atrim=0:${seconds.toFixed(3)},asetpts=N/SR/TB`, "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", out]);
        return existsSync(out) ? out : null;
      } catch { return null; }
    };

    if (useSourceAsNarration) {
      const src = await sourceTrack();
      if (src) { await run(ffmpegPath, ["-y", "-i", src, "-c:a", "copy", output]); return { kind: "GROK_NARRATION", sourceUsed: true }; }
      // The plan said to use it and it is not there: fall back to the synthesised line rather than silence.
      await audioSegment(narrationPath || null, seconds, output);
      return { kind: "NARRATION_FALLBACK", sourceUsed: false };
    }

    if (keepSource && decision === "KEEP_GROK_AMBIENCE_USE_ELEVENLABS") {
      const src = await sourceTrack();
      if (src && narrationPath) {
        const narr = path.join(workDir, `nar_${String(index).padStart(3, "0")}.m4a`);
        await audioSegment(narrationPath, seconds, narr);
        const gain = Number.isFinite(plan.sourceAudioGainDb) ? plan.sourceAudioGainDb : -18;
        // Narration first so the mix follows its length; the bed is attenuated and then sidechain-ducked
        // under the voice, which is what "supporting" means in a mix rather than "quieter".
        await run(ffmpegPath, ["-y", "-i", narr, "-i", src,
          "-filter_complex", `[1:a]volume=${gain}dB,aresample=48000[bed];[0:a]asplit=2[n1][n2];[bed][n1]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[duck];[n2][duck]amix=inputs=2:duration=first:dropout_transition=0[a]`,
          "-map", "[a]", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", output]);
        return { kind: "NARRATION_OVER_AMBIENCE", sourceUsed: true, sourceGainDb: gain, ducked: true };
      }
      if (src && !narrationPath) { await run(ffmpegPath, ["-y", "-i", src, "-c:a", "copy", output]); return { kind: "AMBIENCE_ONLY", sourceUsed: true }; }
    }

    // Everything else — including every muted-speech scene and every unmeasured one — is narration alone.
    await audioSegment(narrationPath || null, seconds, output);
    return { kind: narrationPath ? "NARRATION_ONLY" : "SILENCE", sourceUsed: false };
  }

  async function assembleWithAudio({ clips, workDir, outputPath, title = "", aspectRatio = "9:16", includeTitleCard = true, music = null, subtitleMode = "embed", subtitleText = null }) {
    if (!Array.isArray(clips) || clips.length === 0) throw err("E_ASSEMBLE_NO_CLIPS", "at least one clip is required");
    for (const c of clips) if (!c || typeof c.path !== "string" || !existsSync(c.path)) throw err("E_ASSEMBLE_CLIP_MISSING", "a scene clip file is missing");
    await mkdir(workDir, { recursive: true });
    const { width, height } = dimsFor(aspectRatio);
    const fps = DEFAULT_FPS;

    // 1) normalize video segments (silent) + per-scene audio segments of matching duration.
    const vSegs = [], aSegs = [], actualDurs = [];
    if (includeTitleCard && title) { const tc = path.join(workDir, "seg_title.mp4"); await titleCard(tc, { width, height, fps, title }); vSegs.push(tc); const ta = path.join(workDir, "aud_title.m4a"); await audioSegment(null, 1.5, ta); aSegs.push(ta); }
    for (let i = 0; i < clips.length; i += 1) {
      const seg = path.join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
      await normalizeClip(clips[i].path, seg, {
        width, height, fps,
        fadeSeconds: Number.isFinite(clips[i].fadeSeconds) ? clips[i].fadeSeconds : 0.3,
        trimIn: clips[i].trimIn ?? null, trimOut: clips[i].trimOut ?? null
      });
      vSegs.push(seg);
      const dur = (await probe(seg).catch(() => ({ durationSeconds: clips[i].durationSeconds }))).durationSeconds || clips[i].durationSeconds || 6;
      const aud = path.join(workDir, `aud_${String(i).padStart(3, "0")}.m4a`);
      // P0 Step 5C.47 - the scene's audio plan decides what the soundtrack is made of.
      //
      // normalizeClip strips the clip's audio with -an, so before this the source track was discarded
      // unconditionally: ambience the routing gate had decided to KEEP never reached the film, and a scene
      // whose own voice read the narration could not have used it. Absent a plan the old behaviour stands,
      // which is narration-or-silence.
      await sceneAudio({ plan: clips[i].audioPlan || null, clipPath: clips[i].path, narrationPath: clips[i].narrationPath || null, seconds: dur, output: aud, workDir, index: i });
      aSegs.push(aud); actualDurs.push(dur);
    }
    // 2) concat video (stream copy — identical params) + concat narration audio.
    const vList = path.join(workDir, "vconcat.txt"); await writeFile(vList, vSegs.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const videoOnly = path.join(workDir, "video.mp4"); await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", vList, "-c", "copy", videoOnly]);
    const aList = path.join(workDir, "aconcat.txt"); await writeFile(aList, aSegs.map((s) => `file '${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
    const narrTrack = path.join(workDir, "narration.m4a"); await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", aList, "-c", "copy", narrTrack]);

    // 3) final audio: narration alone, or narration + music sidechain-ducked, then loudnorm.
    const finalAudio = path.join(workDir, "final_audio.m4a");
    const musicPath = music && music.path && existsSync(music.path) ? music.path : null;
    if (musicPath) {
      const mv = Number.isFinite(music.volume) ? Math.max(0, Math.min(1, music.volume)) : 0.5;
      await run(ffmpegPath, ["-y", "-i", narrTrack, "-stream_loop", "-1", "-i", musicPath,
        // Narration ([n2]) is the FIRST amix input so the mix duration follows the (finite) narration
        // track, not the looped music — otherwise -shortest would clip the video tail.
        "-filter_complex", `[1:a]volume=${mv.toFixed(2)},aresample=48000[m];[0:a]asplit=2[n1][n2];[m][n1]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[duck];[n2][duck]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
        // loudnorm resamples internally and does NOT put the rate back. Left unpinned the encoder lands on
        // 96 kHz, which every film shipped so far carries — a rate no delivery target asks for and several
        // reject. Pin it to the 48 kHz the rest of the chain already uses.
        "-map", "[a]", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", finalAudio]);
    } else {
      await run(ffmpegPath, ["-y", "-i", narrTrack, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", finalAudio]);
    }

    // 4) subtitles from provided text (or narration) — sidecar SRT + embed/burn.
    const srt = typeof subtitleText === "string" && subtitleText.trim() ? subtitleText : buildSrt(clips.map((c, i) => ({ durationSeconds: actualDurs[i] ?? c.durationSeconds, narration: c.narration || c.heading || "" })));
    const srtPath = outputPath.replace(/\.mp4$/i, ".srt"); await writeFile(srtPath, srt || "1\n00:00:00,000 --> 00:00:01,000\n \n", "utf8");

    // 5) combine video + final audio (+ subtitle). Burn-in re-encodes video; embed is a copy;
    // "none" muxes no subtitle track (the sidecar .srt is still written for reference).
    //
    // The PICTURE decides how long the film is, and `-shortest` cannot say that: it applies to EVERY input,
    // including the subtitle stream, so a cue set that ends before the last shot silently truncates the
    // movie to the final cue. That is how a 13.0s plan came out as 12.18s. Pinning the output to the
    // measured video length says the same thing without letting a caption cut the film.
    const videoMeta = await probe(videoOnly).catch(() => ({ durationSeconds: null }));
    const hardDuration = Number.isFinite(videoMeta.durationSeconds) && videoMeta.durationSeconds > 0
      ? ["-t", videoMeta.durationSeconds.toFixed(3)] : ["-shortest"];
    let ok = false;
    if (subtitleMode === "none") {
      await run(ffmpegPath, ["-y", "-i", videoOnly, "-i", finalAudio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", ...hardDuration, "-movflags", "+faststart", outputPath]);
      ok = true;
    }
    if (!ok && subtitleMode === "burn" && srt.trim()) {
      // Windows separators are rewritten rather than escaped because libass reparses this path a second
      // time; the quote is escaped because outputPath is caller-supplied and a quote in it would close the
      // subtitles='…' section early and turn the rest of the filename into filter options.
      const srtFilter = escapeFilterPath(srtPath, { windowsSeparators: true });
      try { await run(ffmpegPath, ["-y", "-i", videoOnly, "-i", finalAudio, "-vf", `subtitles='${srtFilter}':force_style='Fontsize=18,Alignment=2,MarginV=48,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,Outline=1'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", ...hardDuration, "-movflags", "+faststart", outputPath], { timeoutMs: 300_000 }); ok = true; } catch { ok = false; }
    }
    if (!ok) {
      // embed mov_text (default / burn fallback)
      try { await run(ffmpegPath, ["-y", "-i", videoOnly, "-i", finalAudio, "-i", srtPath, "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=und", ...hardDuration, "-movflags", "+faststart", outputPath]); ok = true; }
      catch { await run(ffmpegPath, ["-y", "-i", videoOnly, "-i", finalAudio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", ...hardDuration, "-movflags", "+faststart", outputPath]); }
    }

    // 6) poster thumbnail.
    const thumbPath = outputPath.replace(/\.mp4$/i, ".jpg");
    try { await run(ffmpegPath, ["-y", "-ss", "1", "-i", outputPath, "-vframes", "1", "-q:v", "3", thumbPath]); } catch { /* thumbnail best-effort */ }

    const meta = await probe(outputPath);
    const probeFull = await probeStreams(outputPath);
    const info = await stat(outputPath);
    return Object.freeze({
      outputPath, srtPath, thumbnailPath: existsSync(thumbPath) ? thumbPath : null, sizeBytes: info.size, container: "mp4",
      durationSeconds: meta.durationSeconds, width: meta.width, height: meta.height, sceneCount: clips.length,
      hasSubtitles: Boolean(srt.trim()) && subtitleMode !== "none", hasAudio: probeFull.hasAudio, videoCodec: probeFull.videoCodec, audioCodec: probeFull.audioCodec, hasMusic: Boolean(musicPath)
    });
  }

  // 5C.11: deterministic ORIGINAL ambient music bed (pure lavfi synthesis — no copyrighted audio,
  // no network). Styles are simple layered sine chords; the bed is looped/ducked by
  // assembleWithAudio like any uploaded music file.
  async function makeAmbientBed({ outputPath, seconds = 30, style = "CALM" }) {
    const dur = Math.min(300, Math.max(4, Math.round(Number(seconds) || 30)));
    const chords = {
      CALM: [220, 277, 330], WARM: [174, 220, 261], NIGHT: [146, 196, 220], PULSE: [110, 165, 220]
    }[String(style || "CALM").toUpperCase()] || [220, 277, 330];
    const inputs = [];
    for (const f of chords) inputs.push("-f", "lavfi", "-i", `sine=frequency=${f}:duration=${dur}`);
    const mix = `amix=inputs=${chords.length}:duration=longest,tremolo=f=0.15:d=0.4,volume=0.35,aresample=48000`;
    await run(ffmpegPath, ["-y", ...inputs, "-filter_complex", mix, "-c:a", "aac", "-b:a", "128k", outputPath]);
    const info = await stat(outputPath);
    return { outputPath, sizeBytes: info.size, container: "m4a", durationSeconds: dur };
  }

  // ffprobe: video/audio codecs + presence (for render verification).
  async function probeStreams(file) {
    try {
      const { out } = await run(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file], { timeoutMs: 30_000 });
      const streams = (JSON.parse(out).streams) || [];
      const v = streams.find((s) => s.codec_type === "video"), a = streams.find((s) => s.codec_type === "audio");
      return { hasAudio: Boolean(a), videoCodec: v ? v.codec_name : null, audioCodec: a ? a.codec_name : null };
    } catch { return { hasAudio: false, videoCodec: null, audioCodec: null }; }
  }

  // Validate an uploaded media file (music/voiceover): container/duration/size via ffprobe.
  async function inspectMedia(file) {
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile() || info.size <= 0) throw err("E_MEDIA_MISSING", "file missing or empty");
    const streams = await probeStreams(file);
    const meta = await probe(file).catch(() => ({}));
    return { sizeBytes: info.size, durationSeconds: meta.durationSeconds ?? null, hasAudio: streams.hasAudio, audioCodec: streams.audioCodec, videoCodec: streams.videoCodec };
  }

  return Object.freeze({ probe, probeStreams, inspectMedia, assemble, assembleWithAudio, makeAmbientBed, buildSrt, dimsFor, _ffmpegPath: ffmpegPath, _ffprobePath: ffprobePath });
}

export async function readSrt(p) { return existsSync(p) ? readFile(p, "utf8") : null; }
