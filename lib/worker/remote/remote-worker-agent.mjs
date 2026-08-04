// P0 Step 5C.31 — REMOTE WORKER AGENT (worker side, runs on the other Windows machine).
//
// The agent is deliberately dumb about business rules and smart about execution safety. It holds the
// outbound WSS session to Studio, asks for work, and — when the hub grants a lease — drives the SAME
// certified local Cloak/Grok lifecycle the Studio host uses (daemon -> profile -> PREPARE/SUBMIT/TRACK
// -> local media). It then hands the result back: verified upload first, terminal report second.
//
// Safety properties the agent must not break, and how it keeps them:
//
//  * ONE submission per attempt. The agent reports SUBMIT_ATTEMPTED to the hub BEFORE the single
//    provider click and treats any failure after that point as possibly-submitted (never retried).
//    The machine-local one-invocation guard (keyed on the pipeline attempt id) is the second lock.
//  * NEVER invents state. It reports facts; the hub decides terminals. If the socket drops mid-run the
//    agent does NOT re-run: on reconnect it reports what it knows and lets the hub settle.
//  * NEVER logs a secret. The credential is read from DPAPI into memory, used once per connection in
//    the Authorization header, and never written to a frame, a log line or a diagnostic bundle.

import WebSocket from "ws";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  DELIVERY_PROTOCOL_VERSION, REMOTE_WORKER_WS_PATH, S2W, W2S, makeFrame, parseFrame
} from "./remote-protocol.mjs";

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

function newCommandId() { return `cmd_${randomBytes(12).toString("hex")}`; }
function nowIso() { return new Date().toISOString(); }

// The heartbeat period arrives in the server's WELCOME frame, so it is remote input and gets clamped on
// arrival as well as at the sender.
//
// A floor alone is not enough, which is the part that is easy to miss: Node cannot represent a delay above
// 2^31-1 ms, and setInterval does not reject one — it warns and falls back to **1 ms**. So `Math.max(5000, x)`
// turns a 20-second heartbeat into a 1 ms flood for any x above that threshold, which is the opposite of what
// the floor was protecting against. A non-numeric value folds the same way, via NaN. The ceiling is the
// gateway's own documented maximum (control-plane config bounds this to 1000..120000), so every value a
// well-behaved server can send passes through untouched.
export const HEARTBEAT_INTERVAL_MIN_MS = 5_000;
export const HEARTBEAT_INTERVAL_MAX_MS = 120_000;
export const HEARTBEAT_INTERVAL_DEFAULT_MS = 20_000;

export function resolveHeartbeatIntervalMs(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return HEARTBEAT_INTERVAL_DEFAULT_MS;
  return Math.min(HEARTBEAT_INTERVAL_MAX_MS, Math.max(HEARTBEAT_INTERVAL_MIN_MS, Math.trunc(requested)));
}

export async function sha256File(file) {
  const h = createHash("sha256");
  await new Promise((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", resolve);
  });
  return h.digest("hex");
}

export function createRemoteWorkerAgent({
  studioUrl,                 // https://studio.example.com  (wss:// derived)
  workerId,
  getCredential,             // () => Promise<string>  — resolved from DPAPI at connect time, never cached on disk
  executor,                  // { runGeneration(spec, hooks), probeCapabilities(), hostLabel }
  bundleVersion = "0.0.0",
  buildCommit = null,
  logger = null,
  now = () => Date.now(),
  WebSocketImpl = WebSocket,
  fetchImpl = globalThis.fetch,
  reconnect = true
} = {}) {
  if (typeof studioUrl !== "string" || !/^https?:\/\//.test(studioUrl)) throw new TypeError("studioUrl required");
  if (typeof getCredential !== "function") throw new TypeError("getCredential required");
  if (!executor || typeof executor.runGeneration !== "function") throw new TypeError("executor.runGeneration required");

  const base = studioUrl.replace(/\/+$/, "");
  const wsUrl = `${base.replace(/^http/, "ws")}${REMOTE_WORKER_WS_PATH}`;
  const uploadUrl = `${base}/api/worker/artifact`;

  let ws = null, connected = false, stopped = false, backoff = RECONNECT_MIN_MS;
  let heartbeatTimer = null, reconnectTimer = null;
  let sequence = 0;
  const state = {
    approved: false, draining: true, workspaceId: null, sessionId: null,
    currentJob: null,        // { jobId, attemptId, leaseExpiresAt }
    running: false,
    lastError: null
  };
  const pendingGrants = new Map(); // jobId -> resolve(grant)

  const log = (lvl, event, fields) => { try { logger?.[lvl]?.(event, fields); } catch { /* */ } };
  const nextSeq = () => (sequence += 1);

  function send(frame) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }
  function sendCommand(type, { jobId = null, attemptId = null, payload = null } = {}) {
    const cid = newCommandId();
    send(makeFrame({ type, messageId: `msg_${randomBytes(9).toString("hex")}`, commandId: cid, sequence: nextSeq(), workerId, jobId, attemptId, payload }));
    return cid;
  }

  async function connect() {
    if (stopped) return;
    let credential;
    try { credential = await getCredential(); }
    catch (e) { log("error", "REMOTE_AGENT_CREDENTIAL_UNAVAILABLE", { code: e?.code || null }); scheduleReconnect(); return; }
    if (typeof credential !== "string" || !credential.startsWith("wcred_")) {
      log("error", "REMOTE_AGENT_CREDENTIAL_INVALID", {});
      scheduleReconnect(); return;
    }
    // The credential appears here and nowhere else. It is not stored on the socket object, not put in
    // a frame, and the local `credential` binding goes out of scope with this function.
    ws = new WebSocketImpl(wsUrl, { headers: { Authorization: `Bearer ${credential}` }, handshakeTimeout: 20_000, perMessageDeflate: false });
    credential = null;

    ws.on("open", () => { connected = true; backoff = RECONNECT_MIN_MS; void sendHello(); });
    ws.on("message", (data, isBinary) => { void onMessage(data, isBinary); });
    ws.on("error", (e) => { state.lastError = e?.message ? "SOCKET_ERROR" : null; });
    ws.on("close", (code) => {
      connected = false;
      stopHeartbeat();
      log("info", "REMOTE_AGENT_DISCONNECTED", { code });
      // 4003/4004 = credential revoked / worker disabled: the agent must NOT hammer the server. It backs
      // off to the maximum interval and keeps trying slowly so a re-pair is picked up without a restart.
      if (code === 4003 || code === 4004 || code === 4005) backoff = RECONNECT_MAX_MS;
      scheduleReconnect();
    });
  }

  async function sendHello() {
    let capabilities = null;
    try { capabilities = await executor.probeCapabilities?.(); } catch { capabilities = null; }
    send(makeFrame({
      type: W2S.HELLO, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId,
      payload: {
        workerId, deliveryProtocolVersion: DELIVERY_PROTOCOL_VERSION,
        bundleVersion, buildCommit,
        osCaption: executor.osCaption || null, architecture: process.arch,
        hostLabel: executor.hostLabel || null,
        capabilities
      }
    }));
  }

  function startHeartbeat(intervalMs) {
    stopHeartbeat();
    // The bound is applied here, at the timer, rather than only inside the helper. resolveHeartbeatIntervalMs
    // already guarantees the range and is what the tests exercise; repeating Math.min/Math.max at the call
    // site means a reader (and a static analyser) can see the timer is bounded without following a function
    // call out of this file.
    const periodMs = Math.min(
      HEARTBEAT_INTERVAL_MAX_MS,
      Math.max(HEARTBEAT_INTERVAL_MIN_MS, resolveHeartbeatIntervalMs(intervalMs))
    );
    heartbeatTimer = setInterval(async () => {
      let caps = null;
      try { caps = await executor.probeCapabilities?.(); } catch { caps = null; }
      send(makeFrame({ type: W2S.HEARTBEAT, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId, payload: caps || {} }));
      // Renew the lease while a run is in flight so a long generation never loses ownership.
      if (state.currentJob && state.running) send(makeFrame({ type: W2S.LEASE_RENEW, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId, jobId: state.currentJob.jobId }));
    }, periodMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  function scheduleReconnect() {
    if (!reconnect || stopped || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(RECONNECT_MAX_MS, Math.round(backoff * 1.8));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  async function onMessage(data, isBinary) {
    const fr = parseFrame(data, isBinary);
    if (!fr.ok) return;
    const f = fr.frame;
    switch (f.t) {
      case S2W.HELLO_ACK: {
        const d = f.d || {};
        if (d.accepted !== true) { log("error", "REMOTE_AGENT_HANDSHAKE_REFUSED", { code: d.code || null }); return; }
        state.workspaceId = d.workspaceId || null;
        state.sessionId = d.sessionId || null;
        state.approved = d.approved === true;
        state.draining = d.draining !== false;
        startHeartbeat(d.heartbeatIntervalMs);
        log("info", "REMOTE_AGENT_CONNECTED", { workspaceId: state.workspaceId, approved: state.approved, draining: state.draining, protocol: d.serverProtocolVersion });
        if (!state.draining && !state.running) send(makeFrame({ type: W2S.READY, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId }));
        return;
      }
      case S2W.PING: {
        send(makeFrame({ type: W2S.PONG, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId }));
        return;
      }
      case S2W.DRAIN: {
        state.draining = true;
        sendCommand(W2S.DRAIN_ACK, { payload: { inflight: state.running ? 1 : 0 } });
        return;
      }
      case S2W.OFFER: {
        // One at a time: an agent that is already running refuses politely rather than queueing work it
        // cannot start (the hub simply keeps the offer for the next READY).
        if (state.running || state.currentJob) return;
        if (state.draining) return;
        state.currentJob = { jobId: f.j, attemptId: f.a, leaseExpiresAt: f.d?.leaseExpiresAt || null };
        sendCommand(W2S.ACCEPT, { jobId: f.j, attemptId: f.a });
        return;
      }
      case S2W.LEASE_GRANTED: {
        if (!state.currentJob || state.currentJob.jobId !== f.j) return;
        state.currentJob.leaseExpiresAt = f.d?.leaseExpiresAt || null;
        void runJob(f.j, f.a, f.d || {});
        return;
      }
      case S2W.LEASE_RENEWED: {
        if (state.currentJob && state.currentJob.jobId === f.j) state.currentJob.leaseExpiresAt = f.d?.leaseExpiresAt || null;
        return;
      }
      case S2W.UPLOAD_GRANT: {
        // f.j is a server-supplied job id used as a Map key. A Map is the reason this is safe and a plain
        // object would not be: Map.get consults only entries put there by requestUploadGrant below, never a
        // prototype, so "__proto__" or "toString" return undefined rather than an inherited function. The
        // typeof check states that invariant in the code instead of leaving it to the reader.
        const resolveGrant = pendingGrants.get(f.j);
        if (typeof resolveGrant === "function") { pendingGrants.delete(f.j); resolveGrant(f.d || null); }
        return;
      }
      case S2W.NACK: {
        state.lastError = f.d?.code || null;
        log("warn", "REMOTE_AGENT_NACK", { code: f.d?.code || null, jobId: f.j || null });
        return;
      }
      case S2W.ACK:
      case S2W.UPDATE_AVAILABLE:
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- execution
  async function runJob(jobId, attemptId, spec) {
    state.running = true;
    let submitAttempted = false;
    try {
      const result = await executor.runGeneration(
        { jobId, generationAttemptId: attemptId, prompt: spec.prompt, durationSeconds: spec.durationSeconds, aspectRatio: spec.aspectRatio, providerAccountHint: spec.providerAccountHint },
        {
          onGatePassed: () => { sendCommand(W2S.PROGRESS, { jobId, attemptId, payload: { stage: "GATE_PASSED" } }); },
          // Recorded BEFORE the single click: from this point the attempt is never auto-retried, by
          // anyone, on any machine.
          onSubmitAttempted: () => { submitAttempted = true; sendCommand(W2S.SUBMIT_ATTEMPTED, { jobId, attemptId }); },
          onSubmitted: (providerSubmissionId = null) => { sendCommand(W2S.SUBMITTED, { jobId, attemptId, payload: { providerSubmissionId } }); }
        }
      );
      if (result && result.status === "COMPLETED" && result.mediaPath) {
        await deliverResult(jobId, attemptId, result);
      } else if (result && result.possiblySubmitted === true) {
        sendCommand(W2S.FAIL, { jobId, attemptId, payload: { code: result.code || "E_GENERATION_SUBMIT_UNCERTAIN", possiblySubmitted: true } });
      } else {
        sendCommand(W2S.FAIL, { jobId, attemptId, payload: { code: result?.code || "E_GENERATION_FAILED_PRE_SUBMIT", possiblySubmitted: submitAttempted } });
      }
    } catch (e) {
      // An exception AFTER SUBMIT_ATTEMPTED is possibly-submitted by definition. The hub, not the agent,
      // turns that into SUBMIT_UNCERTAIN.
      sendCommand(W2S.FAIL, { jobId, attemptId, payload: { code: sanitize(e?.code) || "E_GENERATION_RUN_ERROR", possiblySubmitted: submitAttempted } });
    } finally {
      state.running = false;
      state.currentJob = null;
      if (!state.draining) send(makeFrame({ type: W2S.READY, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId }));
    }
  }

  function sanitize(code) { return typeof code === "string" && /^E_[A-Z0-9_]{2,60}$/.test(code) ? code : null; }

  async function deliverResult(jobId, attemptId, result) {
    const file = result.mediaPath;
    const info = await stat(file);
    const sha256 = await sha256File(file);
    // Ask for an upload grant bound to THIS job/attempt and THIS exact hash+size.
    const grant = await new Promise((resolve) => {
      pendingGrants.set(jobId, resolve);
      send(makeFrame({ type: W2S.RESULT_READY, messageId: `msg_${randomBytes(9).toString("hex")}`, workerId, jobId, attemptId, payload: { sha256, sizeBytes: info.size, mime: "video/mp4" } }));
      const t = setTimeout(() => { if (pendingGrants.delete(jobId)) resolve(null); }, 30_000);
      if (t.unref) t.unref();
    });
    if (!grant || !grant.uploadToken) {
      sendCommand(W2S.FAIL, { jobId, attemptId, payload: { code: "E_REMOTE_UPLOAD_INVALID", possiblySubmitted: true } });
      return;
    }
    let credential;
    try { credential = await getCredential(); } catch { credential = null; }
    if (!credential) { sendCommand(W2S.FAIL, { jobId, attemptId, payload: { code: "E_REMOTE_UPLOAD_FORBIDDEN", possiblySubmitted: true } }); return; }
    const res = await fetchImpl(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "x-avc-upload": grant.uploadToken,
        "Content-Type": "video/mp4",
        "Content-Length": String(info.size)
      },
      body: createReadStream(file),
      duplex: "half"
    });
    credential = null;
    if (!res.ok) {
      let code = "E_REMOTE_UPLOAD_INVALID";
      try { const b = await res.json(); if (typeof b?.code === "string") code = b.code; } catch { /* */ }
      // A failed upload is NOT a failed generation: the provider was already used. Report it as
      // possibly-submitted so the hub records the honest outcome instead of a retryable failure.
      sendCommand(W2S.FAIL, { jobId, attemptId, payload: { code, possiblySubmitted: true } });
      return;
    }
    sendCommand(W2S.ARTIFACT_UPLOADED, { jobId, attemptId, payload: { sha256, sizeBytes: info.size } });
    sendCommand(W2S.COMPLETE, {
      jobId, attemptId,
      payload: { resultId: result.resultId || null, media: { durationSeconds: result.durationSeconds ?? null, width: result.width ?? null, height: result.height ?? null } }
    });
  }

  return Object.freeze({
    async start() { stopped = false; await connect(); },
    async stop() {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      // A clean shutdown while holding PRE-SUBMIT work hands it straight back; the hub refuses to
      // release anything possibly-submitted, so this can never cause a double submission.
      if (state.currentJob && !state.running) sendCommand(W2S.RELEASE, { jobId: state.currentJob.jobId });
      try { ws?.close(1000, "NORMAL"); } catch { /* */ }
    },
    status() {
      return {
        connected, workspaceId: state.workspaceId, approved: state.approved, draining: state.draining,
        running: state.running, currentJobId: state.currentJob?.jobId || null,
        bundleVersion, buildCommit, protocolVersion: DELIVERY_PROTOCOL_VERSION, lastError: state.lastError, at: nowIso()
      };
    },
    _state: state
  });
}

// Adapts the bundle's local provider runtime (registry + accountActions + authorization store) into the
// `executor` shape the agent expects. This is the ONLY place the agent touches Cloak: everything below
// is the certified single-invocation generation path, unchanged, running on the remote machine.
export function createLocalCloakExecutor({ registry, accountActions, issueAuthorization, listAccounts, internalOrigin = null, ownerRoot, hostLabel = null, osCaption = null }) {
  if (!registry || !accountActions || typeof issueAuthorization !== "function" || typeof listAccounts !== "function") {
    throw new TypeError("createLocalCloakExecutor requires registry, accountActions, issueAuthorization, listAccounts");
  }
  const mediaRoot = `${ownerRoot}\\generated-media`;

  function eligibleAccounts() {
    let accounts = [];
    try { accounts = listAccounts() || []; } catch { accounts = []; }
    return accounts
      .filter((a) => a && a.provider === "GROK" && a.enabled !== false && (a.status === "READY" || a.profileState === "READY"))
      .sort((a, b) => (a.providerAccountId < b.providerAccountId ? -1 : 1));
  }

  return Object.freeze({
    hostLabel, osCaption,
    async probeCapabilities() {
      const accounts = eligibleAccounts();
      return {
        cloakReady: accounts.length > 0,
        providerReady: accounts.length > 0,
        interactiveSession: typeof process.env.SESSIONNAME === "string" && process.env.SESSIONNAME !== "Services",
        actions: ["GENERATE_IMAGINE_VIDEO"],
        maxConcurrentGenerations: 1,
        nodeVersion: process.versions.node
      };
    },
    // spec: { jobId, generationAttemptId, prompt, durationSeconds, aspectRatio, providerAccountHint }
    async runGeneration(spec, hooks = {}) {
      const accounts = eligibleAccounts();
      const chosen = spec.providerAccountHint
        ? accounts.find((a) => a.providerAccountId === spec.providerAccountHint) || null
        : accounts[0] || null;
      if (!chosen) return { status: "FAILED", code: "E_GENERATION_ACCOUNT_UNRESOLVED" };
      let localAccount, authorization;
      try { localAccount = registry.resolveProxiedLocal(chosen.providerAccountId, { requireActive: false }); }
      catch { return { status: "FAILED", code: "E_GENERATION_ACCOUNT_UNRESOLVED" }; }
      try { authorization = issueAuthorization({ providerAccountId: localAccount.id, action: "GENERATE_IMAGINE_VIDEO", origin: internalOrigin }); }
      catch { return { status: "FAILED", code: "E_GENERATION_AUTHORIZATION_FAILED" }; }

      let submitted = false;
      const onProgress = (evt) => {
        try {
          if (evt.type === "GATE_PASSED") hooks.onGatePassed?.();
          else if (evt.type === "SUBMIT_ATTEMPTED") { submitted = true; hooks.onSubmitAttempted?.(); }
        } catch { /* a hook must never break the run */ }
      };

      let result;
      try {
        result = await accountActions.generateImagineVideo(localAccount, authorization, {
          jobId: spec.jobId, generationAttemptId: spec.generationAttemptId, prompt: spec.prompt,
          durationSeconds: spec.durationSeconds, aspectRatio: spec.aspectRatio, onProgress
        });
      } catch (e) {
        return { status: "FAILED", code: sanitizeLocal(e?.code) || "E_GENERATION_RUN_ERROR", possiblySubmitted: submitted };
      }
      const invocationConsumed = result?.invocationCount === 1;
      if (result?.status === "COMPLETED" && result?.hasResult === true && result?.localMedia) {
        try { hooks.onSubmitted?.(result?.resultAsset?.resultId || null); } catch { /* */ }
        const rel = result.localMedia.relativePath.split("/").join(path.sep);
        return {
          status: "COMPLETED",
          mediaPath: path.join(mediaRoot, rel),
          resultId: result.resultAsset?.resultId || null,
          durationSeconds: result.localMedia.durationSeconds ?? null,
          width: result.localMedia.width ?? null,
          height: result.localMedia.height ?? null
        };
      }
      if (invocationConsumed || result?.status === "SUBMIT_UNCERTAIN") {
        return { status: "UNCERTAIN", code: "E_GENERATION_SUBMIT_UNCERTAIN", possiblySubmitted: true };
      }
      return { status: "FAILED", code: sanitizeLocal(result?.reason) || "E_GENERATION_FAILED_PRE_SUBMIT", possiblySubmitted: submitted };
    }
  });
}

function sanitizeLocal(code) { return typeof code === "string" && /^E_[A-Z0-9_]{2,60}$/.test(code) ? code : null; }
