// P0 Step 5C.10 — movie control plane: provider-free END-TO-END against a REAL disposable PostgreSQL
// + REAL ffmpeg, with a FAKE 5C.9E generation facade (no real Grok). Proves the full slice:
// idea → story → storyboard → scene jobs (via the generation facade) → completed clips → assembled
// valid MP4 → correlation → restart persistence. SKIPS if the PG binaries or ffmpeg are absent.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { ffmpegPaths, ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const { Client } = pg;
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }
async function rejects(name, fn, frag) { try { await fn(); assert.fail(name + " expected reject"); } catch (e) { if (e instanceof assert.AssertionError && /expected reject/.test(e.message)) throw e; check(name, `${e.code || ""} ${e.message || ""}`.includes(frag), true); } }

if (!livePgAvailable() || !ffmpegRunnable(ffmpegStatic) || !ffmpegRunnable(ffprobeStaticPath)) {
  console.log("Step 5C.10 movie control plane: 0 passed, 0 failed (SKIPPED — no PostgreSQL or ffmpeg)");
  process.exit(0);
}

// A FAKE 5C.9E generation facade: enqueue returns a job+attempt; on the first getForUi it "completes"
// the job by writing a REAL short clip (ffmpeg testsrc) at the job's aspect ratio, then reports
// COMPLETED + media. It never runs a real provider.
function makeFakeGeneration(mediaRoot) {
  const jobs = new Map();
  const dims = (ar) => (ar === "16:9" ? [1280, 720] : ar === "1:1" ? [512, 512] : [720, 1280]);
  return {
    _jobs: jobs,
    async ensureBootstrap() { return { workerId: "wrk_00000000000000000000000000", projectId: "prj_00000000000000000000000000" }; },
    async enqueue({ prompt, durationSeconds, aspectRatio }) {
      const jobId = generateId("job"); const attemptId = generateId("attempt");
      jobs.set(jobId, { jobId, attemptId, prompt, durationSeconds: durationSeconds || 2, aspectRatio: aspectRatio || "9:16", polled: 0 });
      return { jobId, generationAttemptId: attemptId, state: "QUEUED" };
    },
    async requestStart({ jobId }) { return { dispatchStatus: "OFFERED", offerId: "off_x" }; },
    async getForUi(jobId) {
      const j = jobs.get(jobId); if (!j) return null;
      j.polled += 1;
      // First poll: still generating. Second poll: complete + write the clip.
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

const live = await startDisposablePg({ namePrefix: "mov" });
const mediaRoot = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".movie-test-"));
let adapter = null;
try {
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  const ws = generateId("ws"), user = generateId("usr");
  try { try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    const res = await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "mov" });
    check("A0 migrations apply to latest", res.applied.length + res.alreadyApplied, loadMigrationFiles(MIGRATIONS_DIR).length);
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'MOV',$2)", [ws, user]);
  } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws } };
  const gen = makeFakeGeneration(mediaRoot);
  const assembler = createMovieAssembler();
  const movie = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot });

  // ---- create project ----
  const p = await movie.createProject({ title: "The Rower", genre: "drama", targetDurationSeconds: 18, aspectRatio: "9:16", inputMode: "IDEA", idea: "a young woman rows across a misty lake at sunrise" });
  check("T1 project created DRAFT", p.status, "DRAFT");
  check("T1 project id is mov_", /^mov_[0-9A-HJKMNP-TV-Z]{26}$/.test(p.id), true);

  // ---- draft + edit story ----
  const story = await movie.draftStory({ projectId: p.id });
  check("T2 story drafted with beats", story.beats.length >= 3, true);
  check("T2 project STORY_READY", (await movie.getProject(p.id)).status, "STORY_READY");
  const edited = await movie.setStory({ projectId: p.id, story: { ...story, title: "The Rower", characters: [{ name: "Mai", description: "a woman in a red scarf" }] } });
  check("T2 edited story persisted", edited.characters[0].name, "Mai");

  // ---- storyboard ----
  const scenes = await movie.planStoryboard({ projectId: p.id });
  check("T3 storyboard planned (3-10 scenes)", scenes.length >= 3 && scenes.length <= 10, true);
  check("T3 scene prompt carries continuity (character)", scenes[0].videoPrompt.includes("red scarf"), true);
  check("T3 project STORYBOARD_READY", (await movie.getProject(p.id)).status, "STORYBOARD_READY");
  // edit a planned scene
  const e1 = await movie.updateScene({ sceneId: scenes[0].id, patch: { narration: "Mai unties the boat at dawn" } });
  check("T3 planned scene editable", e1.narration, "Mai unties the boat at dawn");

  // ---- generate scenes (via the fake 5C.9E facade) ----
  const g = await movie.generateAllScenes({ projectId: p.id });
  check("T4 all scenes started generation", g.started, scenes.length);
  const afterStart = await movie.listScenes(p.id);
  check("T4 scenes linked to generation jobs", afterStart.every((s) => /^job_/.test(s.generationJobId || "")), true);
  check("T4 scenes QUEUED, project GENERATING", [afterStart.every((s) => s.state === "QUEUED"), (await movie.getProject(p.id)).status], [true, "GENERATING"]);
  // idempotent: generating scene not restarted
  check("T4 generateScene idempotent on an active scene", (await movie.generateScene({ sceneId: afterStart[0].id })).idempotent, true);
  // scene edit is locked once generating
  await rejects("T4 cannot edit a generating scene prompt", () => movie.updateScene({ sceneId: afterStart[0].id, patch: { videoPrompt: "x" } }), "E_MOVIE_SCENE_LOCKED");

  // ---- refresh to completion (fake completes on 2nd poll → poll twice) ----
  await movie.refreshScenes({ projectId: p.id });
  const done = await movie.refreshScenes({ projectId: p.id });
  check("T5 all scenes COMPLETED with media", done.every((s) => s.state === "COMPLETED" && s.mediaMeta), true);
  check("T5 correlation: scene → job → attempt → result", done.every((s) => s.generationJobId && s.generationAttemptId && s.resultId), true);
  const view = await movie.getProjectView(p.id);
  check("T5 progress readyToAssemble", view.progress.readyToAssemble, true);

  // ---- assemble ----
  const finalMedia = await movie.assembleMovie({ projectId: p.id });
  check("T6 final movie assembled", finalMedia.sizeBytes > 10000, true);
  check("T6 final dims 720x1280", [finalMedia.width, finalMedia.height], [720, 1280]);
  check("T6 scene count recorded", finalMedia.sceneCount, scenes.length);
  check("T6 project COMPLETED", (await movie.getProject(p.id)).status, "COMPLETED");
  const media = await movie.finalMediaFor(p.id);
  check("T6 final movie file resolvable + non-empty", Boolean(media && media.sizeBytes > 10000), true);
  check("T6 final movie under owner media root (safe path)", media.path.startsWith(mediaRoot), true);

  // ---- restart persistence: a FRESH facade sees the same durable state ----
  const movie2 = createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler, ownerMediaRoot: mediaRoot });
  const rp = await movie2.getProject(p.id);
  check("T7 after 'restart' project still COMPLETED with final movie", [rp.status, Boolean(rp.finalMedia && rp.finalMedia.sizeBytes > 0)], ["COMPLETED", true]);
  const rs = await movie2.listScenes(p.id);
  check("T7 after 'restart' scenes still COMPLETED", rs.every((s) => s.state === "COMPLETED"), true);
  check("T7 final movie file still resolvable after restart", Boolean(await movie2.finalMediaFor(p.id)), true);

  // ---- events + listing + archive ----
  const finalView = await movie.getProjectView(p.id);
  check("T8 event timeline recorded", finalView.events.some((e) => e.type === "STORYBOARD_PLANNED") && finalView.events.some((e) => e.type === "MOVIE_COMPLETED"), true);
  check("T8 project appears in listing", (await movie.listProjects()).some((x) => x.id === p.id), true);
  await movie.archiveProject(p.id);
  check("T8 archived project hidden from default listing", (await movie.listProjects()).some((x) => x.id === p.id), false);

  // ---- optimistic revision + workspace isolation ----
  {
    const p2 = await movie.createProject({ title: "Rev Test", inputMode: "IDEA", idea: "a small test idea for revision" });
    const cur = await movie.getProject(p2.id);
    const okUpd = await movie.updateProject({ projectId: p2.id, patch: { title: "Renamed" }, expectedRevision: cur.revision });
    check("T9 update with correct revision succeeds", okUpd.title, "Renamed");
    const stale = await movie.updateProject({ projectId: p2.id, patch: { title: "Stale" }, expectedRevision: cur.revision });
    check("T9 update with stale revision does NOT apply", stale.title, "Renamed");

    // A different workspace never sees this workspace's movie projects (RLS).
    const ws2 = generateId("ws"), user2 = generateId("usr");
    const mc2 = new Client({ connectionString: live.migrationUrl }); await mc2.connect();
    try { await mc2.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user2, `u-${user2}@t.test`]); await mc2.query("SELECT set_config('app.current_workspace',$1,false)", [ws2]); await mc2.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'W2',$2)", [ws2, user2]); } finally { await mc2.end(); }
    const movieW2 = createMovieControlPlane({ persistence: adapter, config: { stagingApi: { workspaceId: ws2 } }, generation: gen, assembler, ownerMediaRoot: mediaRoot });
    check("T9 workspace isolation: W2 sees none of W1's projects", (await movieW2.listProjects()).length, 0);
    check("T9 workspace isolation: W2 cannot read a W1 project by id", await movieW2.getProject(p2.id), null);
  }

  console.log(`Step 5C.10 movie control plane: ${passed} passed, 0 failed`);
} finally {
  try { await adapter?.stop(); } catch { /* */ }
  await live.stop();
  rmSync(mediaRoot, { recursive: true, force: true });
}
