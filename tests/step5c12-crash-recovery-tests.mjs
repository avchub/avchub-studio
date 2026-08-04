// P0 Step 5C.12 — crash/recovery certification (provider-free; real disposable PostgreSQL + the
// REAL 5C.9E generation facade + REAL movie facade with a crash-injected assembler). Proves:
// crash BEFORE submit → resume (no invocation spent); crash AFTER the submit fact → read-only
// track (NEVER a second submit); expired worker lease → reoffer; render crash mid-ffmpeg → FAILED
// row + a NEW version on retry (no double-render of an unchanged hash); restart with a COMPLETED
// project → zero new invocations; publish invocation single-claim + UNCERTAIN never retried;
// stalled-work detection in the ops snapshot; stale runtime-status detection.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { createGenerationControlPlane } from "../control-plane/src/api-staging/generation-control-plane.mjs";
import { createMovieControlPlane } from "../control-plane/src/api-staging/movie-control-plane.mjs";
import { createMovieAssembler } from "../lib/movie/movie-assembler.mjs";
import { createLocalTextProvider } from "../lib/movie/text-provider.mjs";
import { contentRepository as crepo } from "../control-plane/src/persistence/repositories/content-repository.mjs";
import { createOpsSnapshot } from "../lib/ops/ops-snapshot.mjs";
import { generateId } from "../lib/protocol/ids.mjs";
import { ffmpegPaths, ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const { Client } = pg;
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }

if (!livePgAvailable() || !ffmpegRunnable(ffmpegStatic) || !ffmpegRunnable(ffprobeStaticPath)) {
  console.log("Step 5C.12 crash/recovery: 0 passed, 0 failed (SKIPPED — no PostgreSQL or ffmpeg)");
  process.exit(0);
}

const live = await startDisposablePg({ namePrefix: "c12r" });
const mediaRoot = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".crash-test-"));
let adapter = null;
try {
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  const ws = generateId("ws"), user = generateId("usr");
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "c12r" });
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'C12R',$2)", [ws, user]);
  } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws } };
  const tx = (fn) => adapter.tenantTransaction(ws, fn);

  // ================= generation pipeline crash scenarios (REAL 5C.9E facade) =================
  const gen1 = createGenerationControlPlane({ persistence: adapter, config });

  // -- crash BEFORE submit: claimed (ACCEPTED) then the worker dies. Recovery must RESUME it and
  //    the invocation budget must be untouched.
  const jobA = await gen1.enqueue({ prompt: "crash before submit scenario", durationSeconds: 2 });
  await gen1.requestStart({ jobId: jobA.jobId });
  const claimedA = await gen1.claimNextForWorker({ max: 1 });
  check("G1 job claimed (PREPARING) before the crash", [claimedA.length, claimedA[0].jobId], [1, jobA.jobId]);
  const gen2 = createGenerationControlPlane({ persistence: adapter, config }); // "restarted worker"
  const rec1 = await gen2.recover();
  check("G1 crash-before-submit → RESUME (not track, not re-offer)", [rec1.resume.some((r) => r.jobId === jobA.jobId), rec1.track.length], [true, 0]);
  const viewA = await gen2.getForUi(jobA.jobId);
  check("G1 no invocation was spent", [viewA.invocationState ?? null, viewA.state], [null, "PREPARING"]);

  // -- crash AFTER the durable submit fact: recovery must TRACK read-only, never resume/re-run.
  await gen2.markSubmitted({ jobId: jobA.jobId, attemptId: claimedA[0].generationAttemptId });
  const gen3 = createGenerationControlPlane({ persistence: adapter, config });
  const rec2 = await gen3.recover();
  check("G2 crash-after-submit-fact → read-only TRACK", [rec2.track.some((t) => t.jobId === jobA.jobId), rec2.resume.some((r) => r.jobId === jobA.jobId)], [true, false]);
  const viewA2 = await gen3.getForUi(jobA.jobId);
  check("G2 invocation CONSUMED exactly once, state SUBMITTED", [viewA2.invocationState, viewA2.state], ["CONSUMED", "SUBMITTED"]);
  await gen3.submitUncertain({ jobId: jobA.jobId, reason: "tracking could not verify (test)" });
  check("G2 unverifiable tracked job terminates SUBMIT_UNCERTAIN (never re-run)", (await gen3.getForUi(jobA.jobId)).state, "SUBMIT_UNCERTAIN");

  // -- expired worker lease on an UNACCEPTED offer → recovery reoffers it (Case A), same attempt.
  const jobB = await gen1.enqueue({ prompt: "expired lease scenario", durationSeconds: 2 });
  await gen1.requestStart({ jobId: jobB.jobId });
  await tx((c) => c.query("UPDATE job_offers SET offer_expires_at=now()-interval '1 hour', lease_expires_at=now()-interval '1 hour' WHERE workspace_id=$1 AND job_id=$2", [ws, jobB.jobId]));
  const rec3 = await gen3.recover();
  check("G3 expired unaccepted offer reoffered by recovery", rec3.reoffered.length >= 1, true);
  const claimedB = await gen3.claimNextForWorker({ max: 4 });
  check("G3 reoffered job claimable again, SAME attempt id", [claimedB.length, claimedB[0].generationAttemptId], [1, (await gen3.getForUi(jobB.jobId)).generationAttemptId]);

  // ================= movie render crash scenarios (REAL facade, crash-injected assembler) ======
  const realAsm = createMovieAssembler();
  let renderCalls = 0, crashNext = true;
  const crashyAsm = {
    ...realAsm,
    assembleWithAudio: (args) => {
      renderCalls += 1;
      if (crashNext) { crashNext = false; throw Object.assign(new Error("simulated ffmpeg crash"), { code: "E_FFMPEG_FAILED" }); }
      return realAsm.assembleWithAudio(args);
    }
  };
  const fakeGen = {
    async ensureBootstrap() { return gen1.ensureBootstrap(); },
    async enqueue(i) { return gen1.enqueue(i); },
    async requestStart(i) { return gen1.requestStart(i); },
    async getForUi(id) { return gen1.getForUi(id); }
  };
  const movie = createMovieControlPlane({ persistence: adapter, config, generation: fakeGen, assembler: crashyAsm, ownerMediaRoot: mediaRoot, textProviders: { LOCAL: createLocalTextProvider() } });
  const p = await movie.createProject({ title: "Crash Movie", inputMode: "IDEA", idea: "a tiny crash test story", targetDurationSeconds: 18 });
  await movie.draftStory({ projectId: p.id });
  const scenes = await movie.planStoryboard({ projectId: p.id });
  // Complete the scenes directly with real tiny clips (the generation path is certified elsewhere).
  for (const s of scenes) {
    const dir = path.join(mediaRoot, "jobs", `fake_${s.id}`); mkdirSync(dir, { recursive: true });
    const clip = path.join(dir, "generated.mp4");
    const r = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x570:rate=24:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { windowsHide: true });
    check(`M0 fixture clip for scene ${s.ordinal}`, r.status, 0);
    await tx(async (c) => {
      await c.query("UPDATE movie_scenes SET state='COMPLETED', media_meta=$3, generation_job_id='job_01ARZ3NDEKTSV4RRFFQ69G5FAV', generation_attempt_id='attempt_01ARZ3NDEKTSV4RRFFQ69G5FAV', result_id='r' WHERE workspace_id=$1 AND id=$2",
        [ws, s.id, JSON.stringify({ relativePath: `jobs/fake_${s.id}/generated.mp4`, sizeBytes: 1000, container: "mp4" })]);
    });
  }
  // Crash mid-render → render row FAILED (durable evidence), then retry succeeds as a NEW version.
  let crashed = false;
  try { await movie.renderMovie({ projectId: p.id }); } catch { crashed = true; }
  check("M1 render crash surfaces + row FAILED", [crashed, (await movie.listRenders(p.id))[0].state], [true, "FAILED"]);
  const r2 = await movie.renderMovie({ projectId: p.id });
  check("M1 retry after crash = NEW version, old row preserved as evidence", [r2.render.version, (await movie.listRenders(p.id)).length], [2, 2]);
  const callsAfter = renderCalls;
  const r2b = await movie.renderMovie({ projectId: p.id });
  check("M1 unchanged hash after recovery → NO double-render", [r2b.idempotent, renderCalls], [true, callsAfter]);

  // -- restart while a render is "running": a stalled RENDERING row is detected, and a fresh
  //    facade renders a NEW version without touching it.
  await tx(async (c) => {
    await crepo.insertRender(c, ws, { movieProjectId: p.id, renderHash: "sha256:stalled" });
    await c.query("UPDATE movie_renders SET updated_at=now()-interval '2 hours' WHERE workspace_id=$1 AND state='RENDERING'", [ws]);
  });
  const ops = createOpsSnapshot({ persistence: adapter, workspaceId: ws, mediaRoot, ffmpegPath: ffmpegStatic, ffprobePath: ffmpegStatic });
  const snap1 = await ops.snapshot();
  check("M2 stalled RENDERING detected by the ops snapshot", [snap1.db.stalledRenders, snap1.readiness.degraded.includes("STALLED_RENDERS")], [1, true]);
  check("M2 uncertain-needs-review flagged (SUBMIT_UNCERTAIN job)", snap1.readiness.degraded.includes("UNCERTAIN_NEEDS_REVIEW"), true);
  check("M2 core readiness NOT blocked by degraded-only conditions", snap1.readiness.ready, true);

  // -- restart with a COMPLETED project: fresh facade, view intact, zero new invocations.
  const movie2 = createMovieControlPlane({ persistence: adapter, config, generation: fakeGen, assembler: realAsm, ownerMediaRoot: mediaRoot });
  const view = await movie2.getProjectView(p.id, { refresh: true });
  check("M3 restart: project COMPLETED + scenes intact", [view.project.status, view.scenes.every((s) => s.state === "COMPLETED")], ["COMPLETED", true]);
  const snap2 = await ops.snapshot();
  check("M3 no new jobs/invocations appeared on restart", (snap2.db.jobs.QUEUED || 0) + (snap2.db.jobs.PREPARING || 0), (snap1.db.jobs.QUEUED || 0) + (snap1.db.jobs.PREPARING || 0));

  // ================= publish exactly-once primitives ================================
  const pub = await tx((c) => crepo.insertPublishAttempt(c, ws, { movieProjectId: p.id, target: "PACKAGE" }));
  const claim1 = await tx((c) => crepo.reservePublishInvocation(c, ws, pub.id));
  const claim2 = await tx((c) => crepo.reservePublishInvocation(c, ws, pub.id));
  check("P1 publish invocation single-claim (double reserve refused)", [claim1, claim2], [true, false]);
  await tx((c) => crepo.updatePublishAttempt(c, ws, pub.id, { patch: { state: "UNCERTAIN", submitState: "UNCERTAIN" } }));
  const after = await tx((c) => crepo.updatePublishAttempt(c, ws, pub.id, { patch: { state: "RUNNING" } }));
  check("P1 UNCERTAIN publish is terminal — never reset/retried", [after.changed, after.row.state], [false, "UNCERTAIN"]);

  // ================= stale runtime-status detection (pure) ==========================
  const staleDir = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".stale-test-"));
  mkdirSync(path.join(staleDir, "b3-local-runtime", "runtime"), { recursive: true });
  writeFileSync(path.join(staleDir, "b3-local-runtime", "runtime", "runtime-status.json"), JSON.stringify({ state: "WAITING_FOR_USER_UI_INPUT", pid: 999999999 }));
  const { readRuntimeStatus, pidAlive } = await import("../scripts/ops/cli-util.mjs");
  const st = readRuntimeStatus(staleDir);
  check("S1 stale manifest detected (recorded pid dead)", [st.state, pidAlive(st.pid)], ["WAITING_FOR_USER_UI_INPUT", false]);
  rmSync(staleDir, { recursive: true, force: true });

  console.log(`Step 5C.12 crash/recovery: ${passed} passed, 0 failed`);
} finally {
  try { await adapter?.stop(); } catch { /* */ }
  await live.stop();
  rmSync(mediaRoot, { recursive: true, force: true });
}
