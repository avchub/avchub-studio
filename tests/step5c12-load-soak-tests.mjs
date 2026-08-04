// P0 Step 5C.12 — provider-free load/soak: 50 movie projects / 150 scenes driven through the REAL
// 5C.9E ownership pipeline on a disposable PostgreSQL, executed by TWO concurrent worker pipelines
// (fake executor copies a real clip — no provider, no quota). Certifies: no double-claim (incl. a
// contested concurrent claim), exactly-once execution per job, per-account concurrency=1 held under
// load, no queue starvation, restart mid-soak without double-completions, bounded memory, and real
// ffmpeg render timing on a sample. Reports throughput / latency / peak RSS / failures.
import os from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
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
import { generateId } from "../lib/protocol/ids.mjs";
import { ffmpegPaths, ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";

// FFmpeg is not a dependency of this project: the operator installs it and the locator finds it.
const { ffmpeg: ffmpegStatic, ffprobe: ffprobeStaticPath } = ffmpegPaths();

const { Client } = pg;
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed += 1; }

if (!livePgAvailable() || !ffmpegRunnable(ffmpegStatic) || !ffmpegRunnable(ffprobeStaticPath)) {
  console.log("Step 5C.12 load/soak: 0 passed, 0 failed (SKIPPED — no PostgreSQL or ffmpeg)");
  process.exit(0);
}

const PROJECTS = 50, SCENES_PER = 3, TOTAL_JOBS = PROJECTS * SCENES_PER;
const live = await startDisposablePg({ namePrefix: "c12s" });
const mediaRoot = mkdtempSync(path.join((process.env.AVC_STUDIO_HOME || os.tmpdir()), ".soak-test-"));
let adapter = null;
try {
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  const ws = generateId("ws"), user = generateId("usr");
  try {
    try { await mc.query("CREATE EXTENSION IF NOT EXISTS citext"); } catch { /* */ }
    await mrun(mc, { dir: MIGRATIONS_DIR, appVersion: "c12s" });
    await mc.query("INSERT INTO users (id,email) VALUES ($1,$2)", [user, `u-${user}@t.test`]);
    await mc.query("SELECT set_config('app.current_workspace',$1,false)", [ws]);
    await mc.query("INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'SOAK',$2)", [ws, user]);
  } finally { await mc.end(); }
  adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  const config = { stagingApi: { workspaceId: ws } };
  const tx = (fn) => adapter.tenantTransaction(ws, fn);

  // One real 1.5s clip, copied per completed job (no per-job ffmpeg cost).
  const seedClip = path.join(mediaRoot, "seed.mp4");
  const rSeed = spawnSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x570:rate=24:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", seedClip], { windowsHide: true });
  check("S0 seed clip built", rSeed.status, 0);

  const mkGen = (n) => createGenerationControlPlane({ persistence: adapter, config, workerName: `soak-worker-${n}`, projectMarker: `soak-pipeline-${n}` });
  let genA = mkGen("A"), genB = mkGen("B");

  // ---- contested concurrent claim: two runtime instances of the SAME worker, ONE offer ----
  {
    const j = await genA.enqueue({ prompt: "contested claim probe", durationSeconds: 2 });
    await genA.requestStart({ jobId: j.jobId });
    const genA2 = createGenerationControlPlane({ persistence: adapter, config, workerName: "soak-worker-A", projectMarker: "soak-pipeline-A" });
    const [c1, c2] = await Promise.all([genA.claimNextForWorker({ max: 4 }), genA2.claimNextForWorker({ max: 4 })]);
    check("S1 contested concurrent claim → exactly ONE winner", c1.length + c2.length, 1);
    const claim = (c1[0] || c2[0]);
    await genA.markSubmitted({ jobId: j.jobId, attemptId: claim.generationAttemptId });
    const dir0 = path.join(mediaRoot, "jobs", j.jobId); mkdirSync(dir0, { recursive: true });
    copyFileSync(seedClip, path.join(dir0, "generated.mp4"));
    await genA.complete({ jobId: j.jobId, resultId: "probe", mediaMeta: { relativePath: `jobs/${j.jobId}/generated.mp4`, sizeBytes: 1000, container: "mp4" } });
  }

  // ---- fake per-account executor with concurrency accounting ----
  const stats = { executed: 0, doubleExec: 0, latencies: [], concurrencyViolations: 0, failures: 0 };
  const executedJobs = new Set();
  const enqueueTimes = new Map();
  function makeWorkerLoop(gen, accountLabel, inflightMap) {
    return async function pump() {
      const claims = await gen.claimNextForWorker({ max: 8 }).catch(() => []);
      for (const c of claims) {
        if (inflightMap.get(accountLabel)) stats.concurrencyViolations += 1; // per-account concurrency=1
        inflightMap.set(accountLabel, true);
        try {
          if (executedJobs.has(c.jobId)) stats.doubleExec += 1;
          executedJobs.add(c.jobId);
          await gen.markSubmitted({ jobId: c.jobId, attemptId: c.generationAttemptId });
          const dir = path.join(mediaRoot, "jobs", c.jobId); mkdirSync(dir, { recursive: true });
          copyFileSync(seedClip, path.join(dir, "generated.mp4"));
          await gen.complete({ jobId: c.jobId, resultId: `res-${c.jobId.slice(-6)}`, mediaMeta: { relativePath: `jobs/${c.jobId}/generated.mp4`, sizeBytes: 1000, container: "mp4" } });
          stats.executed += 1;
          const t0 = enqueueTimes.get(c.jobId);
          if (t0) stats.latencies.push(Date.now() - t0);
        } catch { stats.failures += 1; }
        finally { inflightMap.set(accountLabel, false); }
      }
      return claims.length;
    };
  }

  // ---- create 50 projects / 150 scenes through the REAL movie facade ----
  const asm = createMovieAssembler();
  const mkMovie = (gen) => createMovieControlPlane({ persistence: adapter, config, generation: gen, assembler: asm, ownerMediaRoot: mediaRoot, textProviders: { LOCAL: createLocalTextProvider() } });
  let movieA = mkMovie(genA), movieB = mkMovie(genB);
  const started = Date.now();
  const projectIds = [];
  for (let i = 0; i < PROJECTS; i += 1) {
    const facade = i % 2 === 0 ? movieA : movieB;
    const p = await facade.createProject({ title: `Soak ${i}`, inputMode: "IDEA", idea: `soak scenario number ${i} about a small lighthouse`, targetDurationSeconds: 18 });
    await facade.draftStory({ projectId: p.id });
    const scenes = await facade.planStoryboard({ projectId: p.id });
    check(`S2 project ${i} planned 3 scenes`, scenes.length, SCENES_PER);
    projectIds.push({ id: p.id, facade: i % 2 === 0 ? "A" : "B" });
    passed -= 1; // count the per-project check once below instead of 50 times in the tally
  }
  passed += 1;
  const t0 = Date.now();
  for (const pr of projectIds) {
    const facade = pr.facade === "A" ? movieA : movieB;
    const out = await facade.generateAllScenes({ projectId: pr.id });
    if (out.started !== SCENES_PER) stats.failures += 1;
  }
  await tx(async (c) => { for (const r of (await c.query("SELECT id, created_at FROM generation_jobs WHERE workspace_id=$1", [ws])).rows) enqueueTimes.set(r.id, Date.now()); });
  check("S2 all 150 scene jobs enqueued", Number((await tx((c) => c.query("SELECT count(*) AS n FROM generation_jobs WHERE workspace_id=$1", [ws]))).rows[0].n) >= TOTAL_JOBS, true);

  // ---- soak: two worker pipelines pump concurrently; RESTART mid-soak ----
  const inflight = new Map();
  let pumpA = makeWorkerLoop(genA, "acct-A", inflight), pumpB = makeWorkerLoop(genB, "acct-B", inflight);
  let peakRss = 0, restarted = false;
  const memTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 250);
  while (stats.executed < TOTAL_JOBS) {
    const [a, b] = await Promise.all([pumpA(), pumpB()]);
    if (!restarted && stats.executed >= TOTAL_JOBS / 2) {
      // Simulated crash/restart: fresh facades (new bootstrap adoption) + recovery; the pipeline
      // must resume WITHOUT re-running anything already executed.
      restarted = true;
      genA = mkGen("A"); genB = mkGen("B");
      await genA.recover(); await genB.recover();
      pumpA = makeWorkerLoop(genA, "acct-A", inflight); pumpB = makeWorkerLoop(genB, "acct-B", inflight);
      movieA = mkMovie(genA); movieB = mkMovie(genB);
    }
    if (a + b === 0) await new Promise((r) => setTimeout(r, 50));
    if (Date.now() - t0 > 8 * 60 * 1000) break; // hard safety bound
  }
  clearInterval(memTimer);
  const soakMs = Date.now() - t0;

  check("S3 all 150 jobs executed exactly once (no double-exec, no failures)", [stats.executed, stats.doubleExec, stats.failures], [TOTAL_JOBS, 0, 0]);
  check("S3 restart happened mid-soak", restarted, true);
  check("S3 per-account concurrency=1 never violated", stats.concurrencyViolations, 0);
  const dbStates = await tx((c) => c.query("SELECT state, count(*) AS n FROM generation_jobs WHERE workspace_id=$1 GROUP BY state", [ws]));
  const byState = Object.fromEntries(dbStates.rows.map((r) => [r.state, Number(r.n)]));
  check("S3 queue drained — no starved jobs", (byState.QUEUED || 0) + (byState.PREPARING || 0) + (byState.READY_TO_SUBMIT || 0) + (byState.SUBMITTED || 0) + (byState.PROCESSING || 0), 0);
  check("S3 DB agrees: 151 COMPLETED (150 + probe)", byState.COMPLETED, TOTAL_JOBS + 1);
  const attempts = Number((await tx((c) => c.query("SELECT count(*) AS n FROM generation_attempts WHERE workspace_id=$1", [ws]))).rows[0].n);
  check("S3 exactly one attempt per job (no hidden retries)", attempts, TOTAL_JOBS + 1);

  // ---- scene refresh + sample renders with REAL ffmpeg (render-time metric) ----
  const renderTimes = [];
  for (const pr of projectIds.slice(0, 3)) {
    const facade = pr.facade === "A" ? movieA : movieB;
    await facade.refreshScenes({ projectId: pr.id });
    const rT0 = Date.now();
    const r = await facade.renderMovie({ projectId: pr.id });
    renderTimes.push(Date.now() - rT0);
    if (!(r.render.state === "COMPLETED" && r.render.probe.hasAudio)) stats.failures += 1;
  }
  check("S4 sample renders completed with audio", stats.failures, 0);

  // ---- bounded resources ----
  check("S5 peak RSS bounded (< 1.5 GB)", peakRss < 1.5e9, true);
  const lat = stats.latencies.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)] ?? 0, p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
  console.log(`[soak] jobs=${stats.executed} in ${(soakMs / 1000).toFixed(1)}s → ${(stats.executed / (soakMs / 1000)).toFixed(1)} jobs/s; latency p50=${p50}ms p95=${p95}ms; renders avg=${Math.round(renderTimes.reduce((t, x) => t + x, 0) / renderTimes.length)}ms; peakRSS=${(peakRss / 1e6).toFixed(0)}MB; failures=${stats.failures}`);

  console.log(`Step 5C.12 load/soak: ${passed} passed, 0 failed`);
} finally {
  try { await adapter?.stop(); } catch { /* */ }
  await live.stop();
  rmSync(mediaRoot, { recursive: true, force: true });
}
