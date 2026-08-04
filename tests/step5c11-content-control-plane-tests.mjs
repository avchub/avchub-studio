// P0 Step 5C.11 — Content Studio control plane: provider-free END-TO-END against a REAL disposable
// PostgreSQL + REAL ffmpeg, with a FAKE 5C.9E generation facade, a FAKE (but valid-WAV) speech
// provider, a FAKE Grok Chat actuator, and a FAKE Facebook actuator. Proves the full slice:
// idea → story attempt (LOCAL + GROK_CHAT, exactly-once) → storyboard → clips → narration TTS
// (exactly-once + reuse) → ambient music → subtitles → timeline → audio-mixed RENDER version
// (renderHash idempotency) → publishing package (zip) → publish attempts (PACKAGE + FB draft +
// uncertain-no-retry) → restart persistence. SKIPS if PG binaries or ffmpeg are absent.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { createLocalTextProvider, createGrokChatTextProvider } from "../lib/movie/text-provider.mjs";
import { createFacebookPublisherProvider } from "../lib/movie/publisher-provider.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { ffmpegPaths, ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const { Client } = pg;
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
async function rejects(name, fn, frag) { try { await fn(); assert.fail(name + " expected reject"); } catch (e) { if (e instanceof assert.AssertionError && /expected reject/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(frag), true); } }

if (!livePgAvailable() || !ffmpegRunnable(ffmpegStatic) || !ffmpegRunnable(ffprobeStaticPath)) {
  console.log("Step 5C.11 content control plane: 0 passed, 0 failed (SKIPPED — no PostgreSQL or ffmpeg)");
  process.exit(0);
}

// FAKE 5C.9E generation facade (same shape as the 5C.10 test): completes on the 2nd poll with a
// REAL testsrc clip.
function makeFakeGeneration(mediaRoot) {
  const jobs = new Map();
  const dims = (ar) => (ar === "16:9" ? [1280, 720] : ar === "1:1" ? [512, 512] : [720, 1280]);
  return {
    async ensureBootstrap() { return { workerId: "wrk_00000000000000000000000000", projectId: "prj_00000000000000000000000000" }; },
    async enqueue({ prompt, durationSeconds, aspectRatio }) {
      const jobId = generateId("job"); const attemptId = generateId("attempt");
      jobs.set(jobId, { jobId, attemptId, prompt, durationSeconds: durationSeconds || 2, aspectRatio: aspectRatio || "9:16", polled: 0 });
      return { jobId, generationAttemptId: attemptId, state: "QUEUED" };
    },
    async requestStart() { return { dispatchStatus: "OFFERED", offerId: "off_x" }; },
    async getForUi(jobId) {
      const j = jobs.get(jobId); if (!j) return null;
      j.polled += 1;
      if (j.polled < 2) return { jobId, state: "PROCESSING", hasMedia: false };
      const dir = path.join(mediaRoot, "jobs", jobId); mkdirSync(dir, { recursive: true });
      const clip = path.join(dir, "generated.mp4");
      if (!existsSync(clip)) {
        const [w, h] = dims(j.aspectRatio);
        const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { windowsHide: true });
        if (r.status !== 0) return { jobId, state: "PROCESSING", hasMedia: false };
      }
      const [w, h] = dims(j.aspectRatio);
      return { jobId, state: "COMPLETED", hasMedia: true, resultId: "res_" + jobId.slice(-8), media: { sizeBytes: 50000, container: "mp4", durationSeconds: 2, width: w, height: h } };
    }
  };
}

// FAKE speech provider: writes a REAL PCM WAV (sine) — counts synthesize calls (exactly-once proof).
function makeFakeSpeech() {
  let calls = 0;
  return {
    kind: "FAKE_TTS",
    get calls() { return calls; },
    async listVoices() { return [{ id: "Fake Voice", name: "Fake Voice", culture: "en-US", gender: "Neutral" }]; },
    async synthesize({ text, outputPath }) {
      calls += 1;
      if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("empty"), { code: "E_TTS_EMPTY" });
      const sr = 22050, seconds = 1.2, n = Math.floor(sr * seconds);
      const data = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(Math.sin(i / 18) * 8000), i * 2);
      const header = Buffer.alloc(44);
      header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii");
      header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
      header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.concat([header, data]));
      return { sizeBytes: 44 + data.length, container: "wav", durationSeconds: seconds };
    }
  };
}

const GOOD_STORY = { title: "The Keeper", synopsis: "A keeper saves a ship at dawn.", styleBible: "misty film, soft light", characters: [{ name: "Anna", description: "keeper in a wool coat" }], beats: [{ heading: "Dawn", narration: "Anna climbs the stairs.", visual: "spiral stairs in fog" }, { heading: "Storm", narration: "A ship appears.", visual: "stormy horizon" }, { heading: "Light", narration: "The beam cuts the fog.", visual: "beam over water" }] };

const live = await startDisposablePg({ namePrefix: "cnt" });
const mediaRoot = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".content-test-"));
let adapter = null;
try {
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  const ws = generateId("ws"), user = generateId("usr");
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "cnt" });
    // The assertion is "every migration applied", not "there are thirty of them". Pinning the count made
    // this suite fail on every schema addition since 0031, which is a maintenance tax and not a check.
    check("A0 every migration applied", res.applied.length + res.alreadyApplied, loadMigrationFiles(MIGRATIONS_DIR).length);
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'CNT',$2)", [ws, user]);
  } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws } };
  const gen = makeFakeGeneration(mediaRoot);
  const realAsm = createMovieAssembler();
  let renderCalls = 0;
  const assembler = { ...realAsm, assembleWithAudio: (args) => { renderCalls += 1; return realAsm.assembleWithAudio(args); } };
  const speech = makeFakeSpeech();
  // Grok Chat fake actuators (happy / uncertain / pre-submit failure).
  const chatHappy = createGrokChatTextProvider({ actuator: async ({ onBeforeSubmit }) => { await onBeforeSubmit(); return { text: "```json\n" + JSON.stringify(GOOD_STORY) + "\n```", responseId: "conv-xyz789" }; } });
  const chatUncertain = createGrokChatTextProvider({ actuator: async ({ onBeforeSubmit }) => { await onBeforeSubmit(); throw Object.assign(new Error("lost after send"), { code: "E_GROK_CHAT_COMPLETION_TIMEOUT" }); } });
  const chatPreFail = createGrokChatTextProvider({ actuator: async () => { throw Object.assign(new Error("no account"), { code: "E_TEXT_NO_ACCOUNT" }); } });
  // 5C.36 requires a voice whose recorded language can be CONFIRMED for the film's locale; an unrecognisable
  // voice is a fallback and automated runs may not use one. This fixture published a voice named "Fake Voice"
  // and nothing else, so the rule correctly refused it and this suite has been red ever since.
  //
  // The fix is to make the fixture behave like a real provider — publish the voice's language, which is what
  // a catalogue entry is for — NOT to relax the rule or pass allowFallbackVoice. The check being exercised is
  // still the real one.
  const voiceCatalogue = [{ voiceId: "Fake Voice", name: "Fake Voice", displayName: "Fake Voice", language: "en" }];
  const deps = { persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot, speech, voiceCatalogue };
  const movie = createMovieControlPlane({ ...deps, textProviders: { LOCAL: createLocalTextProvider(), GROK_CHAT: chatHappy }, publishers: { FACEBOOK: createFacebookPublisherProvider({}) } });

  // ---- T1: project + LOCAL story attempt (durable exactly-once) ----
  const p = await movie.createProject({ title: "The Keeper", genre: "drama", targetDurationSeconds: 18, aspectRatio: "9:16", inputMode: "IDEA", idea: "a lighthouse keeper saves a ship" });
  const localAttempt = await movie.draftStoryViaProvider({ projectId: p.id, provider: "LOCAL" });
  check("T1 LOCAL story attempt completed", [Boolean(localAttempt.attemptId), localAttempt.provider, localAttempt.story.beats.length >= 3], [true, "LOCAL", true]);
  let view = await movie.getProjectView(p.id, { refresh: false });
  check("T1 attempt row COMPLETED + SUBMITTED in view", [view.content.storyAttempts[0].state, view.content.storyAttempts[0].submitState], ["COMPLETED", "SUBMITTED"]);
  check("T1 project STORY_READY", view.project.status, "STORY_READY");

  // ---- T2: GROK_CHAT story attempt (fake actuator) + uncertain/no-retry + pre-submit fail ----
  const chatOut = await movie.draftStoryViaProvider({ projectId: p.id, provider: "GROK_CHAT" });
  check("T2 GROK_CHAT story adopted", [chatOut.provider, chatOut.story.title], ["GROK_CHAT", "The Keeper"]);
  check("T2 project textProvider recorded", (await movie.getProject(p.id)).textProvider, "GROK_CHAT");
  const movieU = createMovieControlPlane({ ...deps, textProviders: { LOCAL: createLocalTextProvider(), GROK_CHAT: chatUncertain } });
  await rejects("T2 submitted-then-lost is UNCERTAIN (not retried)", () => movieU.draftStoryViaProvider({ projectId: p.id, provider: "GROK_CHAT" }), "E_GROK_CHAT_COMPLETION_TIMEOUT");
  const movieF = createMovieControlPlane({ ...deps, textProviders: { LOCAL: createLocalTextProvider(), GROK_CHAT: chatPreFail } });
  await rejects("T2 pre-submit failure is FAILED", () => movieF.draftStoryViaProvider({ projectId: p.id, provider: "GROK_CHAT" }), "E_TEXT_NO_ACCOUNT");
  view = await movie.getProjectView(p.id, { refresh: false });
  const states = view.content.storyAttempts.map((a) => a.state).sort();
  check("T2 attempt history: COMPLETED×2 + FAILED + UNCERTAIN", states, ["COMPLETED", "COMPLETED", "FAILED", "UNCERTAIN"]);
  const uncertainRow = view.content.storyAttempts.find((a) => a.state === "UNCERTAIN");
  check("T2 uncertain attempt keeps UNCERTAIN submitState", uncertainRow.submitState, "UNCERTAIN");
  await rejects("T2 unknown provider unavailable", () => movie.draftStoryViaProvider({ projectId: p.id, provider: "OPENAI" }), "E_MOVIE_TEXT_PROVIDER_UNAVAILABLE");

  // ---- T3: storyboard + scene generation via the fake pipeline ----
  const scenes = await movie.planStoryboard({ projectId: p.id });
  check("T3 storyboard planned", scenes.length >= 3, true);
  await movie.generateAllScenes({ projectId: p.id });
  await movie.refreshScenes({ projectId: p.id });
  const done = await movie.refreshScenes({ projectId: p.id });
  check("T3 scenes COMPLETED with clips", done.every((s) => s.state === "COMPLETED" && s.mediaMeta), true);

  // ---- T4: narration TTS (exactly-once per asset + reuse) ----
  check("T4 voices listed", (await movie.listVoices()).length, 1);
  const n1 = await movie.generateNarration({ projectId: p.id, voiceId: "Fake Voice", rate: 0 });
  // 5C.36 made the duration budget decide the text BEFORE the spend, so a shot the budget silenced is
  // legitimately skipped rather than synthesised and trimmed. The invariant is that every scene is accounted
  // for and nothing failed — asserting "one call per scene" contradicted the budget rule it was written before.
  check("T4 every scene is accounted for, none failed", [n1.generated + n1.skipped, n1.failed.length], [done.length, 0]);
  check("T4 at least one scene was narrated", n1.generated > 0, true);
  const spoken = n1.generated;
  const callsAfterFirst = speech.calls;
  check("T4 one synthesize per narrated scene", callsAfterFirst, spoken);
  const n2 = await movie.generateNarration({ projectId: p.id, voiceId: "Fake Voice", rate: 0 });
  check("T4 unchanged narration is REUSED (no 2nd invocation)", [n2.generated, n2.skipped, speech.calls], [0, done.length, callsAfterFirst]);
  const n3 = await movie.generateNarration({ projectId: p.id, voiceId: "Fake Voice", rate: 0, force: true });
  check("T4 force regenerates (new assets)", [n3.generated, speech.calls], [spoken, callsAfterFirst + spoken]);
  view = await movie.getProjectView(p.id, { refresh: false });
  check("T4 narration assets COMPLETED in view", view.content.narration.filter((a) => a.state === "COMPLETED").length, spoken * 2);
  const narrAsset = view.content.narration.find((a) => a.state === "COMPLETED");
  const narrMedia = await movie.audioMediaFor(p.id, narrAsset.id);
  check("T4 narration audio resolvable (wav)", [Boolean(narrMedia), narrMedia.contentType], [true, "audio/wav"]);

  // ---- T5: ambient music ----
  const mus = await movie.setMusic({ projectId: p.id, source: "AMBIENT", style: "CALM", volume: 0.35 });
  check("T5 ambient bed generated", [mus.source, mus.durationSeconds > 5], ["AMBIENT", true]);
  view = await movie.getProjectView(p.id, { refresh: false });
  check("T5 music settings persisted", [view.project.musicSettings.source, view.project.musicSettings.style, view.project.musicSettings.volume], ["AMBIENT", "CALM", 0.35]);
  check("T5 music audio resolvable", Boolean(await movie.audioMediaFor(p.id, view.project.musicSettings.assetId)), true);

  // ---- T6: subtitles build + edit + validation ----
  const subs = await movie.buildSubtitles({ projectId: p.id });
  check("T6 subtitles built from scenes", subs.text.includes("-->"), true);
  const edited = await movie.setSubtitles({ projectId: p.id, srtText: "1\n00:00:00,000 --> 00:00:03,000\nAnna climbs the stairs.\n", mode: "embed" });
  check("T6 edited subtitles saved", [edited.edited, edited.cueCount], [true, 1]);
  await rejects("T6 invalid SRT rejected", () => movie.setSubtitles({ projectId: p.id, srtText: "garbage" }), "E_SRT_INVALID");
  await rejects("T6 invalid mode rejected", () => movie.setSubtitles({ projectId: p.id, mode: "sideways" }), "E_MOVIE_SUBTITLE_MODE");

  // ---- T7: timeline ----
  const t7 = await movie.updateTimeline({ projectId: p.id, entries: [{ sceneId: done[0].id, trimIn: 0.3, trimOut: 1.6, transitionType: "FADE", transitionSeconds: 0.2 }, { sceneId: done[1].id, transitionType: "CUT" }] });
  const t7s0 = t7.find((s) => s.id === done[0].id);
  check("T7 timeline persisted", [t7s0.trimIn, t7s0.trimOut, t7.find((s) => s.id === done[1].id).transitionType], [0.3, 1.6, "CUT"]);
  await rejects("T7 reversed trim rejected", () => movie.updateTimeline({ projectId: p.id, entries: [{ sceneId: done[0].id, trimIn: 2, trimOut: 1 }] }), "E_MOVIE_TIMELINE_TRIM");

  // ---- T8: audio-mixed render version (real ffmpeg) + renderHash idempotency ----
  const r1 = await movie.renderMovie({ projectId: p.id });
  check("T8 render v1 completed", [r1.idempotent, r1.render.version, r1.render.state], [false, 1, "COMPLETED"]);
  check("T8 probe: h264 + aac + audio + music + subtitles", [r1.render.probe.videoCodec, r1.render.probe.audioCodec, r1.render.probe.hasAudio, r1.render.probe.hasMusic, r1.render.probe.hasSubtitles], ["h264", "aac", true, true, true]);
  check("T8 project final points at the render", (await movie.getProject(p.id)).finalMedia.relativePath.includes("renders/v1"), true);
  const rm = await movie.renderMediaFor(p.id, r1.render.id, "final");
  check("T8 render media resolvable + sized", Boolean(rm && rm.sizeBytes > 20000), true);
  check("T8 thumbnail + srt resolvable", [Boolean(await movie.renderMediaFor(p.id, r1.render.id, "thumbnail")), Boolean(await movie.renderMediaFor(p.id, r1.render.id, "srt"))], [true, true]);
  const callsAfterR1 = renderCalls;
  const r1b = await movie.renderMovie({ projectId: p.id });
  check("T8 unchanged inputs → SAME render, no re-render", [r1b.idempotent, r1b.render.id, renderCalls], [true, r1.render.id, callsAfterR1]);
  await movie.setSubtitles({ projectId: p.id, srtText: "1\n00:00:00,000 --> 00:00:02,000\nA new caption.\n", mode: "embed" });
  const r2 = await movie.renderMovie({ projectId: p.id });
  check("T8 changed subtitles → NEW render version", [r2.idempotent, r2.render.version], [false, 2]);

  // ---- T9: publishing package (zip) ----
  const pkg = await movie.buildPackage({ projectId: p.id, caption: "A lighthouse short film." });
  check("T9 package built for latest render", [pkg.version, pkg.files.includes("final.mp4"), pkg.files.includes("metadata.json"), pkg.zipSizeBytes > 10000], [2, true, true, true]);
  const pkgMedia = await movie.renderMediaFor(p.id, pkg.renderId, "package");
  check("T9 package zip resolvable (application/zip)", [Boolean(pkgMedia), pkgMedia.contentType], [true, "application/zip"]);
  check("T9 caption persisted (redacted metadata)", (await movie.getProject(p.id)).publishingMetadata.caption, "A lighthouse short film.");

  // ---- T10: publish attempts ----
  const pub1 = await movie.publishMovie({ projectId: p.id, target: "PACKAGE" });
  check("T10 PACKAGE publish COMPLETED with postRef", [pub1.state, pub1.postRef.includes("package.zip")], ["COMPLETED", true]);
  await rejects("T10 FB publish unavailable without account", () => movie.publishMovie({ projectId: p.id, target: "FACEBOOK", audience: "DRAFT" }), "E_PUBLISH_FB_UNAVAILABLE");
  await rejects("T10 FB PUBLIC audience refused up front", () => movie.publishMovie({ projectId: p.id, target: "FACEBOOK", audience: "PUBLIC" }), "E_PUBLISH_AUDIENCE");
  const fbHappy = createFacebookPublisherProvider({ actuator: async ({ audience, onBeforeSubmit }) => { await onBeforeSubmit(); return { postRef: `fbdraft:${audience.toLowerCase()}:ok` }; } });
  const movieFb = createMovieControlPlane({ ...deps, textProviders: { LOCAL: createLocalTextProvider() }, publishers: { FACEBOOK: fbHappy } });
  const pub2 = await movieFb.publishMovie({ projectId: p.id, target: "FACEBOOK", audience: "DRAFT", caption: "Draft only." });
  check("T10 FB DRAFT publish COMPLETED (provider-free)", [pub2.state, pub2.postRef], ["COMPLETED", "fbdraft:draft:ok"]);
  const fbUncertain = createFacebookPublisherProvider({ actuator: async ({ onBeforeSubmit }) => { await onBeforeSubmit(); throw Object.assign(new Error("lost"), { code: "E_FB_LOST" }); } });
  const movieFbU = createMovieControlPlane({ ...deps, textProviders: { LOCAL: createLocalTextProvider() }, publishers: { FACEBOOK: fbUncertain } });
  await rejects("T10 FB submitted-then-lost is UNCERTAIN (no retry)", () => movieFbU.publishMovie({ projectId: p.id, target: "FACEBOOK", audience: "ONLY_ME" }), "E_FB_LOST");
  view = await movie.getProjectView(p.id, { refresh: false });
  const pubStates = view.content.publishes.map((a) => `${a.target}:${a.state}`).sort();
  check("T10 publish history durable", pubStates, ["FACEBOOK:COMPLETED", "FACEBOOK:FAILED", "FACEBOOK:UNCERTAIN", "PACKAGE:COMPLETED"]);
  check("T10 uncertain FB attempt never retried (submitState UNCERTAIN)", view.content.publishes.find((a) => a.state === "UNCERTAIN").submitState, "UNCERTAIN");

  // ---- T11: restart persistence (fresh facade over the same durable state) ----
  const movie2 = createMovieControlPlane({ ...deps, textProviders: { LOCAL: createLocalTextProvider() }, publishers: {} });
  const view2 = await movie2.getProjectView(p.id, { refresh: false });
  check("T11 renders survive restart", view2.content.renders.map((r) => r.version).sort(), [1, 2]);
  check("T11 narration + music assets survive restart", [view2.content.narration.length >= done.length, view2.content.music.length >= 1], [true, true]);
  check("T11 publish attempts survive restart", view2.content.publishes.length, 4);
  const callsBeforeRestartRender = renderCalls;
  const r3 = await movie2.renderMovie({ projectId: p.id });
  check("T11 restart render is idempotent (same hash, NO re-render)", [r3.idempotent, r3.render.version, renderCalls], [true, 2, callsBeforeRestartRender]);
  check("T11 render media still resolvable after restart", Boolean(await movie2.renderMediaFor(p.id, r3.render.id, "final")), true);

  console.log(`Step 5C.11 content control plane: ${passed} passed, 0 failed`);
} finally {
  try { await adapter?.stop(); } catch { /* */ }
  await live.stop();
  rmSync(mediaRoot, { recursive: true, force: true });
}
