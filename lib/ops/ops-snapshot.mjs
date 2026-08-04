// P0 Step 5C.12 — bounded operational snapshot (health / readiness / metrics).
//
// One aggregate view for status/doctor/monitoring: liveness (the runtime answering at all),
// readiness (required dependencies healthy), and bounded counters (GROUP BY only — never row
// dumps, never prompts/secrets/absolute paths). Readiness is fail-closed: a broken REQUIRED
// dependency (database, migrations, ffmpeg, media root, disk) blocks READY; optional capabilities
// (TTS voices, READY provider account, backups) only degrade.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diskFreeBytes } from "./production-config.mjs";
import { shippedMigrationCount } from "./shipped-migrations.mjs";
import { ffmpegRunnable } from "../media/ffmpeg-locator.mjs";

// Tracks the applied control-plane migration set (0001..0030). Bumped 19 -> 21 (5C.16 Story Factory) ->
// 30 (5C.21–5C.23 native-auth 0022_native_auth … 0030_auth_owner_bootstrap, applied to production during
// the native-auth activation). A stale value falsely reports a MIGRATIONS_<n>_OF_<expected> blocker and
// forces READY:NO — bump this in lockstep with every production migration.
// Migration expectation comes from the shared shipped-migrations helper (single source of truth).
const expectedMigrations = shippedMigrationCount;
const STALLED_JOB_MS = 15 * 60 * 1000;
const STALLED_RENDER_MS = 30 * 60 * 1000;

async function countBy(client, sql, params = []) {
  const rows = (await client.query(sql, params)).rows;
  const out = {};
  for (const r of rows) out[r.k] = Number(r.n);
  return out;
}

export function createOpsSnapshot({
  persistence, workspaceId, listAccounts = null, speech = null,
  ffmpegPath = null, ffprobePath = null, mediaRoot = null, backupDir = null,
  // P0 Step 5C.15: runtime process-hosting status ({ checked, compatible, reason, ... }). When the runtime
  // sits in an incompatible (kill-on-close) Windows job, automated Cloak sessions cannot run — a hard
  // readiness blocker so doctor/health report it clearly instead of letting TEST_SESSION/generation fail blind.
  hosting = null,
  // P0 Step 5C.29 Phase 0 - maintenance pause state (server-side config), surfaced for health/doctor.
  generationExecutionPaused = false,
  // P0 Step 5C.30 — the generation control plane supplies the pacing projection (waiting count + ETA).
  generationControlPlane = null,
  // P0 Step 5C.35 — the unattended story repair scheduler (null when the feature is off for this runtime).
  storyRepairScheduler = null,
  // P0 Step 5C.31 - the remote delivery plane (hub + durable worker registry). Null when the feature is
  // off, in which case the health snapshot reports remoteDelivery.enabled=false and nothing else changes.
  remoteWorkerHub = null,
  remoteWorkerRegistry = null,
  minFreeGB = 2, warnFreeGB = 10, now = () => Date.now()
} = {}) {
  if (!persistence || typeof persistence.tenantTransaction !== "function") throw new TypeError("ops snapshot requires a persistence adapter");
  if (typeof workspaceId !== "string" || !workspaceId) throw new TypeError("ops snapshot requires a workspaceId");

  // TTS voice enumeration spawns PowerShell — cache it (voices don't change while running).
  let voicesCache = null;

  async function dbSection() {
    try {
      return await persistence.tenantTransaction(workspaceId, async (client) => {
        const migrations = Number((await client.query("SELECT count(*) AS n FROM cp_schema_migrations")).rows[0].n);
        const jobs = await countBy(client, "SELECT state AS k, count(*) AS n FROM generation_jobs WHERE workspace_id=$1 GROUP BY state", [workspaceId]);
        const stalledJobs = Number((await client.query(
          `SELECT count(*) AS n FROM generation_jobs WHERE workspace_id=$1
             AND state NOT IN ('COMPLETED','FAILED_PRE_SUBMIT','SUBMIT_UNCERTAIN','CANCELLED_BEFORE_SUBMIT')
             AND (next_eligible_at IS NULL OR next_eligible_at <= now())
             AND updated_at < now() - interval '${Math.round(STALLED_JOB_MS / 1000)} seconds'`, [workspaceId])).rows[0].n);
        const offers = await countBy(client, "SELECT ownership_status AS k, count(*) AS n FROM job_offers WHERE workspace_id=$1 GROUP BY ownership_status", [workspaceId]);
        const expiredLeases = Number((await client.query(
          "SELECT count(*) AS n FROM job_offers WHERE workspace_id=$1 AND ownership_status IN ('OFFERED','ACCEPTED','RUNNING','SUBMITTING') AND lease_expires_at < now()", [workspaceId])).rows[0].n);
        const movies = await countBy(client, "SELECT status AS k, count(*) AS n FROM movie_projects WHERE workspace_id=$1 AND archived_at IS NULL GROUP BY status", [workspaceId]);
        const renders = await countBy(client, "SELECT state AS k, count(*) AS n FROM movie_renders WHERE workspace_id=$1 GROUP BY state", [workspaceId]);
        const stalledRenders = Number((await client.query(
          `SELECT count(*) AS n FROM movie_renders WHERE workspace_id=$1 AND state='RENDERING'
             AND updated_at < now() - interval '${Math.round(STALLED_RENDER_MS / 1000)} seconds'`, [workspaceId])).rows[0].n);
        const publishes = await countBy(client, "SELECT state AS k, count(*) AS n FROM publish_attempts WHERE workspace_id=$1 GROUP BY state", [workspaceId]);
        // P0 Step 5C.29 Phase 0 - provider work ACTUALLY executing now (a job between prepare and terminal).
        // Must be 0 before a maintenance stop/deploy; proves the pause left nothing running.
        const activeProviderExecutions = Number((await client.query(
          "SELECT count(*) AS n FROM generation_jobs WHERE workspace_id=$1 AND state IN ('PREPARING','READY_TO_SUBMIT','SUBMITTED','PROCESSING')", [workspaceId])).rows[0].n);
        // P0 Step 5C.30 — uncertain splits into a historical FACT and an open ACTION ITEM. A job whose current
        // review verdict is CONFIRMED_* is reviewed (no action); no review or STILL_UNCERTAIN needs one.
        const uncertainRows = await client.query(
          `SELECT count(*)::int total,
                  count(*) FILTER (WHERE r.verdict IN ('CONFIRMED_SUBMITTED','CONFIRMED_NOT_SUBMITTED'))::int reviewed
             FROM generation_jobs p
             LEFT JOIN generation_uncertain_reviews r ON r.workspace_id=p.workspace_id AND r.job_id=p.id AND r.superseded_at IS NULL
            WHERE p.workspace_id=$1 AND p.state='SUBMIT_UNCERTAIN'`, [workspaceId]);
        const historicalSubmissionsUncertain = Number(uncertainRows.rows[0].total);
        const uncertainReviewed = Number(uncertainRows.rows[0].reviewed);
        const uncertainNeedsReview = historicalSubmissionsUncertain - uncertainReviewed;
        // Jobs waiting on provider pacing are QUEUED with a future eligibility — never "stalled", never failed.
        const cooldownRow = await client.query(
          `SELECT count(*)::int n, min(next_eligible_at) soonest FROM generation_jobs
            WHERE workspace_id=$1 AND state='QUEUED' AND next_eligible_at IS NOT NULL AND next_eligible_at > now()`, [workspaceId]);
        const providerCooldownWaitingCount = Number(cooldownRow.rows[0].n);
        // Remote execution provenance: how much of this workspace's work actually ran off-box.
        const remoteRow = await client.query(
          `SELECT count(*) FILTER (WHERE delivery_mode='REMOTE')::int remote_jobs,
                  count(*) FILTER (WHERE delivery_mode='REMOTE' AND state NOT IN ('COMPLETED','FAILED_PRE_SUBMIT','SUBMIT_UNCERTAIN','CANCELLED_BEFORE_SUBMIT'))::int remote_active
             FROM generation_jobs WHERE workspace_id=$1`, [workspaceId]);
        const remoteJobs = Number(remoteRow.rows[0].remote_jobs);
        const remoteActiveJobs = Number(remoteRow.rows[0].remote_active);
        const nearestProviderEligibleAt = cooldownRow.rows[0].soonest ? new Date(cooldownRow.rows[0].soonest).toISOString() : null;
        // P0 Step 5C.35 — unattended story repair. A story waiting on a paced provider lane is WAITING, not
        // stalled and not failed: it holds no lease, no browser and no transaction, and it resumes itself.
        // Only MANUAL_REVIEW is an action item, and even that is reported without blocking readiness.
        let storyRepair = { waiting: 0, active: 0, completed: 0, needsManualReview: 0, blocked: 0, nearestEligibleAt: null };
        try {
          const sr = await client.query(
            `SELECT count(*) FILTER (WHERE state IN ('ELIGIBLE','WAITING_COOLDOWN'))::int waiting,
                    count(*) FILTER (WHERE state='LEASED')::int active,
                    count(*) FILTER (WHERE state='DONE')::int completed,
                    count(*) FILTER (WHERE state='MANUAL_REVIEW')::int needs_review,
                    count(*) FILTER (WHERE state='BLOCKED')::int blocked,
                    min(next_eligible_at) FILTER (WHERE state IN ('ELIGIBLE','WAITING_COOLDOWN')) soonest
               FROM story_repair_schedule WHERE workspace_id=$1`, [workspaceId]);
          const r = sr.rows[0];
          storyRepair = {
            waiting: Number(r.waiting), active: Number(r.active), completed: Number(r.completed),
            needsManualReview: Number(r.needs_review), blocked: Number(r.blocked),
            nearestEligibleAt: r.soonest ? new Date(r.soonest).toISOString() : null
          };
        } catch { /* pre-0038 database: the scheduler simply has no schedule to report */ }
        return { ok: true, migrations, jobs, stalledJobs, offers, expiredLeases, movies, renders, stalledRenders, publishes, activeProviderExecutions,
                 historicalSubmissionsUncertain, uncertainNeedsReview, uncertainReviewed, providerCooldownWaitingCount, nearestProviderEligibleAt,
                 remoteJobs, remoteActiveJobs, storyRepair };
      });
    } catch (e) {
      return { ok: false, error: typeof e?.code === "string" ? e.code : "E_DB_UNAVAILABLE" };
    }
  }

  function accountsSection() {
    if (typeof listAccounts !== "function") return { known: false };
    try {
      const accounts = listAccounts() || [];
      const grok = accounts.filter((a) => a && a.provider === "GROK");
      const ready = grok.filter((a) => a.enabled !== false && (a.status === "READY" || a.profileState === "READY")).length;
      const manual = grok.filter((a) => /MANUAL|REAUTH|CHALLENGE/i.test(String(a.status || a.profileState || ""))).length;
      return { known: true, total: grok.length, ready, manualAction: manual };
    } catch { return { known: false }; }
  }

  async function ttsSection() {
    if (!speech || typeof speech.listVoices !== "function") return { available: false, voices: 0 };
    if (voicesCache !== null) return voicesCache;
    try {
      const voices = await speech.listVoices();
      voicesCache = { available: voices.length > 0, voices: voices.length, kind: speech.kind || null };
    } catch { voicesCache = { available: false, voices: 0 }; }
    return voicesCache;
  }

  function mediaSection() {
    if (!mediaRoot) return { known: false };
    let writable = false;
    try {
      mkdirSync(mediaRoot, { recursive: true });
      const probe = path.join(mediaRoot, `.ops-probe-${now()}`);
      writeFileSync(probe, "ok"); unlinkSync(probe);
      writable = true;
    } catch { writable = false; }
    const disk = diskFreeBytes(existsSync(mediaRoot) ? mediaRoot : path.parse(mediaRoot).root);
    const freeGB = disk.freeBytes === null ? null : disk.freeBytes / 1e9;
    return {
      known: true, writable,
      freeBytes: disk.freeBytes, totalBytes: disk.totalBytes,
      status: freeGB === null ? "UNKNOWN" : freeGB < minFreeGB ? "FAIL" : freeGB < warnFreeGB ? "WARN" : "OK"
    };
  }

  function backupsSection() {
    if (!backupDir || !existsSync(backupDir)) return { known: Boolean(backupDir), count: 0, latestAt: null, ageHours: null };
    try {
      const dirs = readdirSync(backupDir).filter((d) => /^backup-\d{8}-\d{6}$/.test(d));
      let latest = null;
      for (const d of dirs) {
        const manifest = path.join(backupDir, d, "MANIFEST.json");
        if (!existsSync(manifest)) continue;
        const at = statSync(manifest).mtimeMs;
        if (latest === null || at > latest) latest = at;
      }
      return {
        known: true, count: dirs.length,
        latestAt: latest ? new Date(latest).toISOString() : null,
        ageHours: latest ? Math.round((now() - latest) / 3600000 * 10) / 10 : null
      };
    } catch { return { known: true, count: 0, latestAt: null, ageHours: null }; }
  }

  async function snapshot() {
    const db = await dbSection();
    const media = mediaSection();
    const tts = await ttsSection();
    // existsSync is the wrong question here: the locator's usual answer is the bare name "ffmpeg" for PATH
    // to resolve, and existsSync("ffmpeg") looks in the current directory. This section reported
    // present: false on every working PATH installation — a health snapshot that is wrong about a healthy
    // host is worse than one that says nothing.
    const ffmpeg = { present: ffmpegRunnable(ffmpegPath), probePresent: ffmpegRunnable(ffprobePath) };
    const accounts = accountsSection();
    const backups = backupsSection();

    const blockers = [];
    if (!db.ok) blockers.push("DATABASE_UNAVAILABLE");
    else if (expectedMigrations() !== null && db.migrations !== expectedMigrations()) blockers.push(`MIGRATIONS_${db.migrations}_OF_${expectedMigrations()}`);
    if (!ffmpeg.present || !ffmpeg.probePresent) blockers.push("FFMPEG_MISSING");
    if (media.known && !media.writable) blockers.push("MEDIA_ROOT_NOT_WRITABLE");
    if (media.known && media.status === "FAIL") blockers.push("DISK_FULL");
    if (hosting && hosting.compatible === false) blockers.push("RUNTIME_HOST_INCOMPATIBLE_JOB");

    const degraded = [];
    if (!tts.available) degraded.push("TTS_UNAVAILABLE");
    if (accounts.known && accounts.ready === 0) degraded.push("NO_READY_PROVIDER_ACCOUNT");
    if (accounts.known && accounts.manualAction > 0) degraded.push("PROVIDER_MANUAL_ACTION");
    if (db.ok && db.stalledJobs > 0) degraded.push("STALLED_JOBS");
    if (db.ok && db.stalledRenders > 0) degraded.push("STALLED_RENDERS");
    if (db.ok && db.expiredLeases > 0) degraded.push("EXPIRED_LEASES");
    // Only an OPEN action item degrades: a historically-uncertain job whose verdict is recorded is a fact,
    // not an operational problem. STILL_UNCERTAIN keeps the flag until a real verdict is reached.
    if (db.ok && (db.publishes?.UNCERTAIN || 0) + (db.uncertainNeedsReview || 0) > 0) degraded.push("UNCERTAIN_NEEDS_REVIEW");
    // A story waiting out a provider cooldown is NORMAL operation and must never make the Studio look
    // degraded — that is the whole point of durable pacing. Only a story that needs a human is an item.
    if (db.ok && (db.storyRepair?.needsManualReview || 0) > 0) degraded.push("STORY_REPAIR_NEEDS_MANUAL_REVIEW");
    if (media.known && media.status === "WARN") degraded.push("DISK_LOW");
    if (backups.known && backups.latestAt === null) degraded.push("NO_BACKUPS");
    // Maintenance mode is reported as DEGRADED, never a readiness blocker: the Studio stays READY for reads,
    // native auth and the Platform plane while generation execution is deliberately held.
    if (generationExecutionPaused === true) degraded.push("GENERATION_EXECUTION_PAUSED");

    return Object.freeze({
      at: new Date(now()).toISOString(),
      liveness: true,
      readiness: Object.freeze({ ready: blockers.length === 0, blockers: Object.freeze(blockers), degraded: Object.freeze(degraded) }),
      db, media, tts, ffmpeg, accounts, backups,
      generation: Object.freeze({
        executionPaused: generationExecutionPaused === true,
        activeProviderExecutions: db.ok ? (db.activeProviderExecutions ?? 0) : null,
        startupAutoResumeBlocked: generationExecutionPaused === true,
        providerCooldownWaitingCount: db.ok ? (db.providerCooldownWaitingCount ?? 0) : null,
        nearestProviderEligibleAt: db.ok ? (db.nearestProviderEligibleAt ?? null) : null
      }),
      storyRepair: Object.freeze({
        enabled: Boolean(storyRepairScheduler && storyRepairScheduler.enabled && storyRepairScheduler.enabled()),
        busy: Boolean(storyRepairScheduler && storyRepairScheduler.busy && storyRepairScheduler.busy()),
        storyRepairWaiting: db.ok ? (db.storyRepair?.waiting ?? 0) : null,
        storyRepairActive: db.ok ? (db.storyRepair?.active ?? 0) : null,
        nearestStoryRepairEligibleAt: db.ok ? (db.storyRepair?.nearestEligibleAt ?? null) : null,
        storyRepairNeedsManualReview: db.ok ? (db.storyRepair?.needsManualReview ?? 0) : null,
        storyRepairCompleted: db.ok ? (db.storyRepair?.completed ?? 0) : null,
        storyRepairBlocked: db.ok ? (db.storyRepair?.blocked ?? 0) : null,
        stats: storyRepairScheduler && storyRepairScheduler.stats ? storyRepairScheduler.stats() : null
      }),
      remoteDelivery: Object.freeze({
        enabled: Boolean(remoteWorkerHub && remoteWorkerHub.isEnabled && remoteWorkerHub.isEnabled()),
        protocolVersion: remoteWorkerHub ? remoteWorkerHub.protocolVersion : null,
        connectedWorkers: remoteWorkerHub ? remoteWorkerHub.connectedWorkerIds().length : 0,
        remoteJobs: db.ok ? (db.remoteJobs ?? 0) : null,
        remoteActiveJobs: db.ok ? (db.remoteActiveJobs ?? 0) : null
      }),
      uncertain: Object.freeze({
        historicalSubmissionsUncertain: db.ok ? (db.historicalSubmissionsUncertain ?? 0) : null,
        uncertainNeedsReview: db.ok ? (db.uncertainNeedsReview ?? 0) : null,
        uncertainReviewed: db.ok ? (db.uncertainReviewed ?? 0) : null
      }),
      hosting: hosting ? Object.freeze({ checked: hosting.checked === true, compatible: hosting.compatible !== false, reason: hosting.reason ?? null }) : Object.freeze({ checked: false, compatible: true, reason: "not-probed" })
    });
  }

  // Every media relative path the database references (scene clips, audio assets, render outputs,
  // packages, project finals). Used by media cleanup to protect referenced files; bounded strings.
  async function mediaRefs() {
    return persistence.tenantTransaction(workspaceId, async (client) => {
      const refs = new Set();
      const add = (v) => { if (typeof v === "string" && v && !v.includes("..")) refs.add(v); };
      for (const r of (await client.query("SELECT media_meta->>'relativePath' AS p FROM movie_scenes WHERE workspace_id=$1 AND media_meta IS NOT NULL", [workspaceId])).rows) add(r.p);
      for (const r of (await client.query("SELECT media_meta->>'relativePath' AS p FROM scene_audio_assets WHERE workspace_id=$1 AND media_meta IS NOT NULL", [workspaceId])).rows) add(r.p);
      for (const r of (await client.query(
        `SELECT final_media->>'relativePath' AS a, subtitle_media->>'relativePath' AS b,
                thumbnail_media->>'relativePath' AS c, package_media->>'relativePath' AS d
           FROM movie_renders WHERE workspace_id=$1`, [workspaceId])).rows) { add(r.a); add(r.b); add(r.c); add(r.d); }
      for (const r of (await client.query("SELECT final_media->>'relativePath' AS p FROM movie_projects WHERE workspace_id=$1 AND final_media IS NOT NULL", [workspaceId])).rows) add(r.p);
      return [...refs].sort();
    });
  }

  return Object.freeze({ snapshot, mediaRefs });
}

// Human-readable one-page report from a snapshot (for status/doctor output). Pure formatting.
export function formatSnapshotReport(s) {
  const lines = [];
  const flag = (b) => (b ? "OK " : "FAIL");
  lines.push(`Operational snapshot @ ${s.at}`);
  lines.push(`READY: ${s.readiness.ready ? "YES" : "NO"}${s.readiness.blockers.length ? "  blockers: " + s.readiness.blockers.join(", ") : ""}`);
  if (s.readiness.degraded.length) lines.push(`Degraded: ${s.readiness.degraded.join(", ")}`);
  lines.push(`DB: ${flag(s.db.ok)}${s.db.ok ? ` (migrations ${s.db.migrations})` : ` (${s.db.error})`}`);
  if (s.db.ok) {
    lines.push(`Jobs: ${JSON.stringify(s.db.jobs)} stalled=${s.db.stalledJobs}`);
    lines.push(`Offers: ${JSON.stringify(s.db.offers)} expiredLeases=${s.db.expiredLeases}`);
    lines.push(`Movies: ${JSON.stringify(s.db.movies)}`);
    lines.push(`Renders: ${JSON.stringify(s.db.renders)} stalled=${s.db.stalledRenders}`);
    lines.push(`Publishes: ${JSON.stringify(s.db.publishes)}`);
  }
  lines.push(`Media: ${s.media.known ? `${s.media.status} writable=${s.media.writable} free=${s.media.freeBytes === null ? "?" : (s.media.freeBytes / 1e9).toFixed(1) + "GB"}` : "unknown"}`);
  lines.push(`FFmpeg: ${flag(s.ffmpeg.present && s.ffmpeg.probePresent)}  TTS: ${s.tts.available ? `${s.tts.voices} voice(s)` : "unavailable"}`);
  lines.push(`Provider accounts: ${s.accounts.known ? `${s.accounts.ready}/${s.accounts.total} READY${s.accounts.manualAction ? `, ${s.accounts.manualAction} need manual action` : ""}` : "unknown"}`);
  if (s.generation) lines.push(`Generation: ${s.generation.executionPaused ? "PAUSED (maintenance)" : "running"}  activeProviderExecutions=${s.generation.activeProviderExecutions ?? "?"}  startupAutoResumeBlocked=${s.generation.startupAutoResumeBlocked}  waitingProviderCooldown=${s.generation.providerCooldownWaitingCount ?? "?"}${s.generation.nearestProviderEligibleAt ? ` nextEligible=${s.generation.nearestProviderEligibleAt}` : ""}`);
  if (s.uncertain) lines.push(`Uncertain: historical=${s.uncertain.historicalSubmissionsUncertain ?? "?"} needsReview=${s.uncertain.uncertainNeedsReview ?? "?"} reviewed=${s.uncertain.uncertainReviewed ?? "?"}`);
  if (s.remoteDelivery) lines.push(`RemoteDelivery: ${s.remoteDelivery.enabled ? "enabled" : "disabled"}  connectedWorkers=${s.remoteDelivery.connectedWorkers}  remoteJobs=${s.remoteDelivery.remoteJobs ?? "?"} active=${s.remoteDelivery.remoteActiveJobs ?? "?"}`);
  if (s.storyRepair) {
    const eta = s.storyRepair.nearestStoryRepairEligibleAt;
    lines.push(`StoryRepair: ${s.storyRepair.enabled ? "auto" : "manual"}  waiting=${s.storyRepair.storyRepairWaiting ?? "?"} active=${s.storyRepair.storyRepairActive ?? "?"} completed=${s.storyRepair.storyRepairCompleted ?? "?"} needsReview=${s.storyRepair.storyRepairNeedsManualReview ?? "?"}${eta ? `  nextEligibleAt=${eta}` : ""}`);
  }
  lines.push(`Backups: ${s.backups.count} (latest ${s.backups.latestAt ?? "none"}${s.backups.ageHours !== null ? `, ${s.backups.ageHours}h ago` : ""})`);
  return lines.join("\n");
}
