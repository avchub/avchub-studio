#!/usr/bin/env node
// Pure unit tests for the P0 Step 1 protocol contract layer (lib/protocol/*).
// No ui-server, no browser, no Python, no provider credentials, no quota.
// Run: node tests/protocol-tests.mjs

import {
  PROTOCOL_ERRORS, ProtocolError, isProtocolErrorCode
} from "../lib/protocol/errors.mjs";
import {
  resolveHeartbeatIntervalMs, HEARTBEAT_INTERVAL_MIN_MS, HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_DEFAULT_MS
} from "../lib/worker/remote/remote-worker-agent.mjs";
import {
  generateId, validateId, parseId, assertId, generateUlid, isValidUlid,
  ulidTimeMs, ID_PREFIXES, isKnownPrefix
} from "../lib/protocol/ids.mjs";
import {
  WORKER_TO_CLOUD, CLOUD_TO_WORKER, ALL_MESSAGE_TYPES, PROTOCOL_VERSION,
  isKnownMessageType, isWorkerToCloudType, isCloudToWorkerType,
  requiresAcknowledgement, requiredEnvelopeFields, ACK_REQUIRING_TYPES
} from "../lib/protocol/message-types.mjs";
import {
  JOB_STATES, TERMINAL_JOB_STATES, canTransition, assertTransition, isTerminalJobState
} from "../lib/protocol/job-states.mjs";
import {
  makeEnvelope, validateEnvelope, isEnvelope, validateMessageAckPayload,
  MAX_PAYLOAD_BYTES, MAX_RECONCILE_PAYLOAD_BYTES, DEFAULT_SKEW_MS
} from "../lib/protocol/envelope.mjs";
import {
  JOB_ACTIONS, getJobContract, validateJobInput, validateJobOffer, actionConsumesQuota,
  actionRequiredCapability, GROK_DURATIONS, GROK_DEFAULT_DURATION,
  DANGEROUS_FIELDS, makeGrokVideoDurationResult, grokDurationTolerance,
  isDuplicateRequest, ASPECT_FIXED, GENERATION_ACTIONS
} from "../lib/protocol/job-contracts.mjs";

let failures = 0, passed = 0;
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
}
function checkThrows(name, fn, code = undefined) {
  try { fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) {
    if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); }
    else passed += 1;
  }
}

// helper: a full valid id set
const IDS = {
  usr: generateId("usr"), ws: generateId("ws"), wrk: generateId("wrk"),
  job: generateId("job"), asset: generateId("asset"), msg: generateId("msg"),
  corr: generateId("corr"), sess: generateId("sess"), prj: generateId("prj"),
  ep: generateId("ep"), sh: generateId("sh"), pa: generateId("pa"),
  req: generateId("req"), attempt: generateId("attempt"), submission: generateId("submission")
};

// ================= IDs =================
{
  check("all 15 prefixes registered", ID_PREFIXES.length, 15);
  for (const p of ["usr","ws","wrk","job","asset","msg","corr","sess","prj","ep","sh","pa","req","attempt","submission"]) {
    check(`prefix ${p} known`, isKnownPrefix(p), true);
  }
  const id = generateId("job");
  check("generated id body is 26-char ULID", id.split("_")[1].length, 26);
  check("generated ULID valid", isValidUlid(id.split("_")[1]), true);
  check("validateId ok", validateId(id, "job"), true);
  check("validateId wrong prefix", validateId(id, "usr"), false);
  check("validateId no expected prefix ok", validateId(id), true);
  check("parseId", parseId(id).prefix, "job");
  check("assertId returns value", assertId(id, "job"), id);

  // invalid alphabet (contains I, L, O, U)
  check("reject alphabet I", validateId("job_01ILOU000000000000000000", "job"), false);
  check("reject alphabet lowercase", validateId("job_01jq7zk9m3n4p5q6r7s8t9v0a1", "job"), false);
  // wrong length
  check("reject short", validateId("job_01JQ", "job"), false);
  check("reject long", validateId("job_01JQ7ZK9M3N4P5Q6R7S8T9V0A1EXTRA", "job"), false);
  // missing prefix
  check("reject no prefix", validateId("01JQ7ZK9M3N4P5Q6R7S8T9V0A1", "job"), false);
  check("reject empty prefix", validateId("_01JQ7ZK9M3N4P5Q6R7S8T9V0A1", "job"), false);
  // unknown prefix
  check("reject unknown prefix", validateId("xyz_01JQ7ZK9M3N4P5Q6R7S8T9V0A1"), false);
  check("reject malformed", validateId("not-an-id"), false);
  check("reject non-string", validateId(12345), false);

  checkThrows("generateId unknown prefix throws", () => generateId("nope"), PROTOCOL_ERRORS.E_INVALID_ID);
  checkThrows("parseId invalid throws", () => parseId("bad"), PROTOCOL_ERRORS.E_INVALID_ID);
  checkThrows("assertId invalid throws", () => assertId("bad", "job"), PROTOCOL_ERRORS.E_INVALID_ID);

  // ULID timestamp roundtrip (deterministic time)
  const t = 1783820000000;
  check("ulidTimeMs roundtrip", ulidTimeMs(generateUlid(t)), t);
  // two ULIDs at same ms differ (randomness)
  check("ULIDs differ at same ms", generateUlid(t) !== generateUlid(t), true);
  // ULIDs are monotonic-ish by time prefix
  check("later time sorts >= earlier (first 10 chars)", generateUlid(t + 100000).slice(0,10) >= generateUlid(t).slice(0,10), true);
}

// ================= errors =================
{
  check("all error codes recognized", isProtocolErrorCode("E_DANGEROUS_FIELD"), true);
  check("unknown code not recognized", isProtocolErrorCode("E_MADE_UP"), false);
  const e = new ProtocolError(PROTOCOL_ERRORS.E_INVALID_ID, "bad id", { field: "x" });
  check("ProtocolError code", e.code, "E_INVALID_ID");
  check("ProtocolError toJSON safe", JSON.stringify(e.toJSON()).includes("E_INVALID_ID"), true);
  check("ProtocolError name", e.name, "ProtocolError");
  // required error constants present
  for (const c of ["E_PROTOCOL_VERSION","E_UNKNOWN_TYPE","E_INVALID_ENVELOPE","E_INVALID_ID","E_TIMESTAMP_SKEW","E_PAYLOAD_TOO_LARGE","E_IDENTITY_MISMATCH","E_INVALID_TRANSITION","E_UNKNOWN_ACTION","E_INVALID_JOB_INPUT","E_DANGEROUS_FIELD","E_DURATION_OPTION_UNAVAILABLE","E_CAPABILITY_UNAVAILABLE","E_DUPLICATE_REQUEST","E_QUOTA_RETRY_CONFIRMATION_REQUIRED"]) {
    check(`error const ${c}`, PROTOCOL_ERRORS[c], c);
  }
}

// ================= message types =================
{
  check("protocol version 1", PROTOCOL_VERSION, 1);
  check("WORKER_HELLO worker→cloud", isWorkerToCloudType("WORKER_HELLO"), true);
  check("JOB_OFFER cloud→worker", isCloudToWorkerType("JOB_OFFER"), true);
  check("MESSAGE_ACK both directions W→C", isWorkerToCloudType("MESSAGE_ACK"), true);
  check("MESSAGE_ACK both directions C→W", isCloudToWorkerType("MESSAGE_ACK"), true);
  check("STATE_RECONCILE in worker→cloud", WORKER_TO_CLOUD.includes("STATE_RECONCILE"), true);
  check("STATE_RECONCILE_REQUEST in cloud→worker", CLOUD_TO_WORKER.includes("STATE_RECONCILE_REQUEST"), true);
  check("ERROR is known", isKnownMessageType("ERROR"), true);
  check("unknown type rejected", isKnownMessageType("FROB"), false);
  check("non-string type rejected", isKnownMessageType(42), false);

  check("JOB_COMPLETED requires ack", requiresAcknowledgement("JOB_COMPLETED"), true);
  check("STATE_RECONCILE requires ack", requiresAcknowledgement("STATE_RECONCILE"), true);
  check("WORKER_CREDENTIAL_ROTATE requires ack", requiresAcknowledgement("WORKER_CREDENTIAL_ROTATE"), true);
  check("JOB_PROGRESS no ack", requiresAcknowledgement("JOB_PROGRESS"), false);
  check("MESSAGE_ACK never requires ack", requiresAcknowledgement("MESSAGE_ACK"), false);
  check("ack-requiring set count", ACK_REQUIRING_TYPES.length, 7);

  // required envelope fields
  check("JOB_OFFER needs jobId", requiredEnvelopeFields("JOB_OFFER").jobId, true);
  check("WORKER_HEARTBEAT no jobId", requiredEnvelopeFields("WORKER_HEARTBEAT").jobId, false);
  check("WORKER_HEARTBEAT needs workspace+worker", requiredEnvelopeFields("WORKER_HEARTBEAT").workspaceId && requiredEnvelopeFields("WORKER_HEARTBEAT").workerId, true);
  check("PING requires nothing", requiredEnvelopeFields("PING").workspaceId, false);
  check("all types count sane", ALL_MESSAGE_TYPES.length >= 27, true);
}

// ================= envelope =================
{
  const okEnv = makeEnvelope({ type: "WORKER_HEARTBEAT", workspaceId: IDS.ws, workerId: IDS.wrk, payload: { freeBytes: 1 } });
  check("makeEnvelope sets protocolVersion", okEnv.protocolVersion, 1);
  check("makeEnvelope sets messageId", validateId(okEnv.messageId, "msg"), true);
  check("makeEnvelope sets sentAt", typeof okEnv.sentAt, "string");
  check("isEnvelope true", isEnvelope(okEnv), true);
  check("isEnvelope false for junk", isEnvelope({ foo: 1 }), false);

  // wrong protocol version
  checkThrows("bad protocolVersion", () => validateEnvelope({ ...okEnv, protocolVersion: 2 }, { checkSkew: false }), PROTOCOL_ERRORS.E_PROTOCOL_VERSION);
  // missing required workspaceId
  checkThrows("missing workspaceId", () => validateEnvelope({ ...okEnv, workspaceId: undefined }, { checkSkew: false }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  // unknown message type
  checkThrows("unknown type", () => validateEnvelope({ ...okEnv, type: "NOPE" }, { checkSkew: false }), PROTOCOL_ERRORS.E_UNKNOWN_TYPE);
  // invalid messageId
  checkThrows("bad messageId", () => validateEnvelope({ ...okEnv, messageId: "msg_bad" }, { checkSkew: false }), PROTOCOL_ERRORS.E_INVALID_ID);
  // unknown top-level field
  checkThrows("unknown top field", () => validateEnvelope({ ...okEnv, extra: 1 }, { checkSkew: false }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  // bad sentAt
  checkThrows("bad sentAt format", () => validateEnvelope({ ...okEnv, sentAt: "2026-07-12 01:00" }, { checkSkew: false }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  // timestamp skew
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  checkThrows("timestamp skew", () => validateEnvelope({ ...okEnv, sentAt: old }), PROTOCOL_ERRORS.E_TIMESTAMP_SKEW);
  check("skew within window passes", (() => { try { validateEnvelope({ ...okEnv, sentAt: new Date(Date.now() - 30000).toISOString() }); return true; } catch { return false; } })(), true);
  check("DEFAULT_SKEW_MS is 120s", DEFAULT_SKEW_MS, 120000);

  // payload size limit (normal 256KB)
  const big = { blob: "x".repeat(MAX_PAYLOAD_BYTES + 10) };
  checkThrows("payload too large (normal)", () => validateEnvelope({ ...okEnv, payload: big }, { checkSkew: false }), PROTOCOL_ERRORS.E_PAYLOAD_TOO_LARGE);
  // STATE_RECONCILE allows up to 1MB
  const reconcileEnv = makeEnvelope({ type: "STATE_RECONCILE", workspaceId: IDS.ws, workerId: IDS.wrk, payload: { blob: "x".repeat(MAX_PAYLOAD_BYTES + 5000) } });
  check("STATE_RECONCILE >256KB allowed", isEnvelope(reconcileEnv), true);
  const tooBigReconcile = { blob: "x".repeat(MAX_RECONCILE_PAYLOAD_BYTES + 10) };
  checkThrows("STATE_RECONCILE >1MB rejected", () => validateEnvelope({ ...reconcileEnv, payload: tooBigReconcile }, { checkSkew: false }), PROTOCOL_ERRORS.E_PAYLOAD_TOO_LARGE);

  // prototype pollution keys at depth
  const polluted = JSON.parse('{"a":{"b":{"__proto__":{"x":1}}}}');
  checkThrows("pollution deep key", () => validateEnvelope({ ...okEnv, payload: polluted }, { checkSkew: false }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  const pollutedTop = JSON.parse('{"constructor":1}');
  checkThrows("pollution top key", () => validateEnvelope({ ...okEnv, payload: pollutedTop }, { checkSkew: false }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);

  // identity override NOT done here (documented deferral): a mismatched workerId
  // that is still a VALID id passes structural validation (transport layer checks identity).
  check("structural validation ignores identity match", isEnvelope({ ...okEnv, workerId: generateId("wrk") }), true);
}

// ================= MESSAGE_ACK =================
{
  const ackOk = { ackedMessageId: IDS.msg, ackedType: "JOB_COMPLETED", status: "ACCEPTED", serverRevision: 129, errorCode: null };
  check("valid ACCEPTED ack", (() => { validateMessageAckPayload(ackOk); return true; })(), true);
  check("valid via envelope", isEnvelope(makeEnvelope({ type: "MESSAGE_ACK", workspaceId: IDS.ws, workerId: IDS.wrk, payload: ackOk })), true);

  checkThrows("ACCEPTED with errorCode rejected", () => validateMessageAckPayload({ ...ackOk, errorCode: "E_X" }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  check("REJECTED needs errorCode", (() => { validateMessageAckPayload({ ...ackOk, status: "REJECTED", errorCode: "E_JOB_DUPLICATE" }); return true; })(), true);
  checkThrows("REJECTED without errorCode", () => validateMessageAckPayload({ ...ackOk, status: "REJECTED", errorCode: null }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  checkThrows("bad ack status", () => validateMessageAckPayload({ ...ackOk, status: "MAYBE" }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  checkThrows("bad ackedMessageId", () => validateMessageAckPayload({ ...ackOk, ackedMessageId: "job_" + IDS.job.split("_")[1] }), PROTOCOL_ERRORS.E_INVALID_ID);
  checkThrows("unknown ackedType", () => validateMessageAckPayload({ ...ackOk, ackedType: "FROB" }), PROTOCOL_ERRORS.E_UNKNOWN_TYPE);
  checkThrows("serverRevision non-int", () => validateMessageAckPayload({ ...ackOk, serverRevision: 1.5 }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  check("serverRevision null ok", (() => { validateMessageAckPayload({ ...ackOk, serverRevision: null }); return true; })(), true);
  checkThrows("unknown ack field", () => validateMessageAckPayload({ ...ackOk, foo: 1 }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
  // ACK-LOOP: MESSAGE_ACK cannot ack a MESSAGE_ACK
  checkThrows("ack-loop rejected", () => validateMessageAckPayload({ ...ackOk, ackedType: "MESSAGE_ACK" }), PROTOCOL_ERRORS.E_INVALID_ENVELOPE);
}

// ================= job state machine =================
{
  check("11 states", JOB_STATES.length, 11);
  check("4 terminal states", TERMINAL_JOB_STATES.length, 4);
  check("SUCCEEDED terminal", isTerminalJobState("SUCCEEDED"), true);
  check("RUNNING not terminal", isTerminalJobState("RUNNING"), false);

  // valid transitions
  const valid = [
    ["QUEUED","DISPATCHED"],["DISPATCHED","ACCEPTED"],["ACCEPTED","RUNNING"],
    ["RUNNING","NEEDS_MANUAL_ACTION"],["RUNNING","SUCCEEDED"],["RUNNING","FAILED"],
    ["NEEDS_MANUAL_ACTION","RUNNING"],["QUEUED","CANCEL_REQUESTED"],["CANCEL_REQUESTED","CANCELED"],
    ["QUEUED","EXPIRED"],["DISPATCHED","QUEUED"],["RUNNING","INTERRUPTED"],["INTERRUPTED","SUCCEEDED"],
    ["INTERRUPTED","FAILED"],["INTERRUPTED","CANCELED"],["ACCEPTED","INTERRUPTED"],["CANCEL_REQUESTED","SUCCEEDED"]
  ];
  for (const [f,t] of valid) check(`transition ${f}->${t}`, canTransition(f,t), true);
  // same-state no-op
  check("same-state RUNNING->RUNNING", canTransition("RUNNING","RUNNING"), true);
  check("same-state terminal idempotent", canTransition("SUCCEEDED","SUCCEEDED"), true);

  // INVALID: terminal -> running (the critical rule)
  check("SUCCEEDED->RUNNING forbidden", canTransition("SUCCEEDED","RUNNING"), false);
  check("FAILED->RUNNING forbidden", canTransition("FAILED","RUNNING"), false);
  check("CANCELED->RUNNING forbidden", canTransition("CANCELED","RUNNING"), false);
  check("EXPIRED->ANYTHING forbidden", canTransition("EXPIRED","QUEUED"), false);
  check("INTERRUPTED->RUNNING forbidden (recovery only)", canTransition("INTERRUPTED","RUNNING"), false);
  check("QUEUED->SUCCEEDED forbidden (skip)", canTransition("QUEUED","SUCCEEDED"), false);
  check("unknown state false", canTransition("WAT","RUNNING"), false);

  checkThrows("assertTransition invalid throws", () => assertTransition("SUCCEEDED","RUNNING"), PROTOCOL_ERRORS.E_INVALID_TRANSITION);
  checkThrows("assertTransition unknown throws", () => assertTransition("WAT","RUNNING"), PROTOCOL_ERRORS.E_INVALID_TRANSITION);
  check("assertTransition valid returns true", assertTransition("RUNNING","SUCCEEDED"), true);
}

// ================= job action contracts =================
{
  check("13 actions", JOB_ACTIONS.length, 13); // +GENERATE_VIDEO (P0 Step 5C.8A, additive)
  check("dangerous field list count", DANGEROUS_FIELDS.length, 20);

  // every action has a contract
  for (const a of JOB_ACTIONS) check(`contract exists ${a}`, Boolean(getJobContract(a)), true);
  check("unknown action null contract", getJobContract("RUN_COMMAND"), null);
  checkThrows("unknown action rejected", () => validateJobInput("RUN_COMMAND", {}), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  checkThrows("EXECUTE_SCRIPT rejected", () => validateJobInput("EXECUTE_SCRIPT", {}), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);

  // quota + capability helpers
  check("grok-video consumes quota", actionConsumesQuota("GENERATE_GROK_VIDEO"), true);
  check("chatgpt-image consumes quota", actionConsumesQuota("GENERATE_CHATGPT_IMAGE"), true);
  check("grok-image consumes quota", actionConsumesQuota("GENERATE_GROK_IMAGE"), true);
  check("export no quota", actionConsumesQuota("EXPORT_PROJECT"), false);
  check("storage-scan no quota", actionConsumesQuota("STORAGE_SCAN"), false);
  check("session-check no quota", actionConsumesQuota("CHECK_PROVIDER_SESSION"), false);
  check("grok-video capability", actionRequiredCapability("GENERATE_GROK_VIDEO"), "grok.video");
  check("export capability", actionRequiredCapability("EXPORT_PROJECT"), "export.capcut");

  // valid minimal inputs per action. Canonical shape (P0 Step 3): action `input`
  // is business data ONLY — requestIdempotencyKey/generationAttemptId live at the
  // JOB_OFFER payload level (see validateJobOffer block below), not in input.
  const grokVideo = {
    projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, providerAccountId: IDS.pa,
    sourceKeyframeAssetId: IDS.asset, promptSnapshot: "Slow cinematic push-in", baseRevision: 128
  };
  const gv = validateJobInput("GENERATE_GROK_VIDEO", grokVideo);
  check("grok-video default duration 10", gv.requestedDurationSec, GROK_DEFAULT_DURATION);
  check("grok-video default 10 (const)", GROK_DEFAULT_DURATION, 10);
  check("grok-video allowShortFallback default false", gv.allowShortFallback, false);
  check("grok-video aspect default 9:16", gv.aspect, ASPECT_FIXED);
  check("grok durations are 6/10/15", GROK_DURATIONS.join(","), "6,10,15");
  for (const d of GROK_DURATIONS) check(`grok-video duration ${d} accepted`, validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestedDurationSec: d }).requestedDurationSec, d);
  checkThrows("grok-video duration 20 rejected", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestedDurationSec: 20 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("grok-video duration 8 rejected", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestedDurationSec: 8 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  // capability context
  checkThrows("grok-video 15 unsupported by capability", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestedDurationSec: 15 }, { supportedDurationsSec: [10] }), PROTOCOL_ERRORS.E_DURATION_OPTION_UNAVAILABLE);
  check("grok-video 10 supported by capability", validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestedDurationSec: 10 }, { supportedDurationsSec: [10, 15] }).requestedDurationSec, 10);
  check("grok-video no capability context skips cap check", validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestedDurationSec: 15 }).requestedDurationSec, 15);
  checkThrows("grok-video bad aspect", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, aspect: "16:9" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // request-identity fields are REJECTED inside action input (they belong at the
  // JOB_OFFER payload level now).
  checkThrows("input rejects requestIdempotencyKey", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, requestIdempotencyKey: IDS.req }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("input rejects generationAttemptId", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, generationAttemptId: IDS.attempt }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("input rejects parentAttemptId", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, parentAttemptId: IDS.attempt }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("input rejects retryOfJobId", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, retryOfJobId: IDS.job }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // missing required
  checkThrows("grok-video missing keyframe", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, sourceKeyframeAssetId: undefined }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("grok-video empty prompt", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, promptSnapshot: "  " }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("grok-video prompt too long", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, promptSnapshot: "x".repeat(4001) }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("grok-video negative baseRevision", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, baseRevision: -1 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("grok-video bad id", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, projectId: "prj_bad" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // unknown input field
  checkThrows("grok-video unknown field", () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, foo: 1 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // dangerous fields at various depths & casings
  for (const bad of ["command","cmd","shell","executable","executablePath","script","scriptPath","browserArgs","outputPath","absolutePath","cookie","cookies","password","token","accessToken","refreshToken","proxy","proxyPassword","fingerprint","profilePath"]) {
    checkThrows(`dangerous top ${bad}`, () => validateJobInput("GENERATE_GROK_VIDEO", { ...grokVideo, [bad]: "x" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  }
  checkThrows("dangerous nested cookie", () => validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep, locales: ["en-US"], meta: { deep: { cookie: "x" } } }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("dangerous in array", () => validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep, items: [{ token: "x" }] }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("dangerous case-insensitive PASSWORD", () => validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep, PASSWORD: "x" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);

  // OPEN_PROVIDER target must be enum, not URL
  check("open-provider valid target", validateJobInput("OPEN_PROVIDER", { providerAccountId: IDS.pa, target: "imagine" }).target, "imagine");
  checkThrows("open-provider url rejected", () => validateJobInput("OPEN_PROVIDER", { providerAccountId: IDS.pa, target: "https://evil.com" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // IMPORT_MEDIA transferRef not a path
  check("import-media asset transferRef ok", (() => { validateJobInput("IMPORT_MEDIA", { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, kind: "video", transferRef: IDS.asset }); return true; })(), true);
  check("import-media opaque transferRef ok", (() => { validateJobInput("IMPORT_MEDIA", { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, kind: "video", transferRef: "tmp-xyz.1" }); return true; })(), true);
  checkThrows("import-media path transferRef rejected", () => validateJobInput("IMPORT_MEDIA", { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, kind: "video", transferRef: "C:\\evil\\x.mp4" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("import-media bad kind", () => validateJobInput("IMPORT_MEDIA", { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, kind: "gif", transferRef: IDS.asset }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // remaining actions minimal-valid
  check("session-check ok", (() => { validateJobInput("CHECK_PROVIDER_SESSION", { providerAccountId: IDS.pa }); return true; })(), true);
  check("open-login ok", (() => { validateJobInput("OPEN_PROVIDER_LOGIN", { providerAccountId: IDS.pa }); return true; })(), true);
  check("export minimal ok", (() => { validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep }); return true; })(), true);
  check("export locales ok", (() => { validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep, locales: ["en-US","de-DE"] }); return true; })(), true);
  checkThrows("export bad locale", () => validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep, locales: ["xx-YY"] }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  check("storage-scan ok", (() => { validateJobInput("STORAGE_SCAN", {}); return true; })(), true);
  check("cleanup-dry-run ok", (() => { validateJobInput("CLEANUP_DRY_RUN", { projectId: IDS.prj }); return true; })(), true);
  check("create-archive ok", (() => { validateJobInput("CREATE_PROJECT_ARCHIVE", { projectId: IDS.prj, includeRejected: true }); return true; })(), true);
  check("import-archive ok", (() => { validateJobInput("IMPORT_PROJECT_ARCHIVE", { archiveRef: "arc-xyz.1", targetProjectId: IDS.prj }); return true; })(), true);
  check("chatgpt-image ok", (() => { validateJobInput("GENERATE_CHATGPT_IMAGE", { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, providerAccountId: IDS.pa, promptSnapshot: "a room", baseRevision: 1 }); return true; })(), true);
  check("grok-image ok", (() => { validateJobInput("GENERATE_GROK_IMAGE", { projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, providerAccountId: IDS.pa, promptSnapshot: "a room", baseRevision: 1 }); return true; })(), true);
}

// ================= JOB_OFFER envelope (validateJobOffer, canonical shape) =================
{
  check("GENERATION_ACTIONS has 4 entries", GENERATION_ACTIONS.length, 4); // +GENERATE_VIDEO (P0 Step 5C.8A, additive)
  const bizInput = {
    projectId: IDS.prj, episodeId: IDS.ep, shotId: IDS.sh, providerAccountId: IDS.pa,
    sourceKeyframeAssetId: IDS.asset, promptSnapshot: "Slow cinematic push-in", baseRevision: 128
  };
  const offer = {
    action: "GENERATE_GROK_VIDEO",
    requestIdempotencyKey: IDS.req, generationAttemptId: IDS.attempt,
    quotaRisk: true, input: bizInput
  };
  const norm = validateJobOffer(offer);
  check("offer normalizes duration", norm.input.requestedDurationSec, GROK_DEFAULT_DURATION);
  check("offer keeps requestIdempotencyKey at payload level", norm.requestIdempotencyKey, IDS.req);
  check("offer keeps generationAttemptId at payload level", norm.generationAttemptId, IDS.attempt);
  check("offer input has no requestIdempotencyKey", norm.input.requestIdempotencyKey === undefined, true);
  check("offer input has no generationAttemptId", norm.input.generationAttemptId === undefined, true);
  check("acceptedBaseRevision defaults from input.baseRevision", norm.acceptedBaseRevision, 128);
  check("offer quotaRisk preserved", norm.quotaRisk, true);
  check("offer parentAttemptId null when absent", norm.parentAttemptId, null);
  check("offer retryOfJobId null when absent", norm.retryOfJobId, null);

  // deliberate new variant: new req + attempt, links to a parent attempt
  const variant = validateJobOffer({ ...offer, requestIdempotencyKey: generateId("req"), generationAttemptId: generateId("attempt"), parentAttemptId: IDS.attempt, retryOfJobId: IDS.job });
  check("variant parentAttemptId preserved", variant.parentAttemptId, IDS.attempt);
  check("variant retryOfJobId preserved", variant.retryOfJobId, IDS.job);
  check("explicit acceptedBaseRevision honored", validateJobOffer({ ...offer, acceptedBaseRevision: 200 }).acceptedBaseRevision, 200);

  // generation actions REQUIRE req + attempt at payload level
  checkThrows("offer missing requestIdempotencyKey", () => validateJobOffer({ action: "GENERATE_GROK_VIDEO", generationAttemptId: IDS.attempt, input: bizInput }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("offer missing generationAttemptId", () => validateJobOffer({ action: "GENERATE_GROK_VIDEO", requestIdempotencyKey: IDS.req, input: bizInput }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("offer opaque req key rejected", () => validateJobOffer({ ...offer, requestIdempotencyKey: "req-not-ulid" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("offer bad parentAttemptId rejected", () => validateJobOffer({ ...offer, parentAttemptId: "attempt_bad" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("offer bad retryOfJobId rejected", () => validateJobOffer({ ...offer, retryOfJobId: "job_bad" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // unknown offer field + dangerous field at payload level
  checkThrows("offer unknown field rejected", () => validateJobOffer({ ...offer, foo: 1 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("offer dangerous field at payload level", () => validateJobOffer({ ...offer, cookie: "x" }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("offer dangerous field nested in input", () => validateJobOffer({ ...offer, input: { ...bizInput, token: "x" } }), PROTOCOL_ERRORS.E_DANGEROUS_FIELD);
  checkThrows("offer unknown action rejected", () => validateJobOffer({ action: "RUN_COMMAND", input: {} }), PROTOCOL_ERRORS.E_UNKNOWN_ACTION);
  checkThrows("offer quotaRisk non-boolean rejected", () => validateJobOffer({ ...offer, quotaRisk: "yes" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("offer expiresAt non-ISO rejected", () => validateJobOffer({ ...offer, expiresAt: "soon" }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  check("offer expiresAt ISO accepted", validateJobOffer({ ...offer, expiresAt: "2026-07-12T10:00:00Z" }).expiresAt, "2026-07-12T10:00:00Z");

  // capability duration context flows through the offer to input validation
  checkThrows("offer duration unsupported by capability", () => validateJobOffer({ ...offer, input: { ...bizInput, requestedDurationSec: 15 } }, { supportedDurationsSec: [10] }), PROTOCOL_ERRORS.E_DURATION_OPTION_UNAVAILABLE);

  // non-generation action: request identity optional, no quota
  const nonGen = validateJobOffer({ action: "EXPORT_PROJECT", input: { projectId: IDS.prj, episodeId: IDS.ep } });
  check("non-gen offer requestIdempotencyKey null", nonGen.requestIdempotencyKey, null);
  check("non-gen offer quotaRisk false default", nonGen.quotaRisk, false);
}

// ================= grok duration result helper =================
{
  const r1 = makeGrokVideoDurationResult({ requestedDurationSec: 10, confirmedUiDurationSec: 10, actualDurationSec: 10.0 });
  check("no mismatch when equal", r1.durationMismatch, false);
  check("result has toleranceSec field", "toleranceSec" in r1, true);
  check("five distinct fields", ["requestedDurationSec","confirmedUiDurationSec","actualDurationSec","toleranceSec","durationMismatch"].every((k) => k in r1), true);
  const r2 = makeGrokVideoDurationResult({ requestedDurationSec: 15, confirmedUiDurationSec: 15, actualDurationSec: 6.0 });
  check("mismatch when actual differs", r2.durationMismatch, true);
  const r3 = makeGrokVideoDurationResult({ requestedDurationSec: 10, confirmedUiDurationSec: 15, actualDurationSec: null });
  check("mismatch when confirmed differs", r3.durationMismatch, true);
  checkThrows("bad requested duration in result", () => makeGrokVideoDurationResult({ requestedDurationSec: 7 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);

  // A5 tolerance formula: max(0.5, requested*0.05)
  check("tolerance 6 -> 0.5", grokDurationTolerance(6), 0.5);
  check("tolerance 10 -> 0.5", grokDurationTolerance(10), 0.5);
  check("tolerance 15 -> 0.75", grokDurationTolerance(15), 0.75);
  check("result 15 carries tolerance 0.75", makeGrokVideoDurationResult({ requestedDurationSec: 15, actualDurationSec: 15 }).toleranceSec, 0.75);
  // boundary: 15 requested, actual 15.75 = exactly tolerance → NOT mismatch (> is strict)
  check("15 within tolerance (15.75) no mismatch", makeGrokVideoDurationResult({ requestedDurationSec: 15, actualDurationSec: 15.75 }).durationMismatch, false);
  check("15 just over tolerance (15.8) mismatch", makeGrokVideoDurationResult({ requestedDurationSec: 15, actualDurationSec: 15.8 }).durationMismatch, true);
  check("10 within 0.5 (10.5) no mismatch", makeGrokVideoDurationResult({ requestedDurationSec: 10, actualDurationSec: 10.5 }).durationMismatch, false);
  check("10 over 0.5 (10.6) mismatch", makeGrokVideoDurationResult({ requestedDurationSec: 10, actualDurationSec: 10.6 }).durationMismatch, true);
  check("6 within 0.5 (6.5) no mismatch", makeGrokVideoDurationResult({ requestedDurationSec: 6, actualDurationSec: 6.5 }).durationMismatch, false);
  // tolerance override honored
  check("tolerance override widens", makeGrokVideoDurationResult({ requestedDurationSec: 10, actualDurationSec: 12, toleranceSec: 3 }).durationMismatch, false);
  checkThrows("non-finite actual rejected", () => makeGrokVideoDurationResult({ requestedDurationSec: 10, actualDurationSec: Infinity }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("negative tolerance rejected", () => makeGrokVideoDurationResult({ requestedDurationSec: 10, toleranceSec: -1 }), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ================= idempotency pure helper =================
{
  const k1 = generateId("req");
  const seen = new Set([k1]);
  check("duplicate detected", isDuplicateRequest(k1, seen), true);
  check("new key not duplicate", isDuplicateRequest(generateId("req"), seen), false);
  check("no store not duplicate", isDuplicateRequest(generateId("req"), undefined), false);
  checkThrows("invalid idempotency key (opaque)", () => isDuplicateRequest("bad key with spaces", seen), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
  checkThrows("invalid idempotency key (wrong prefix)", () => isDuplicateRequest(generateId("job"), seen), PROTOCOL_ERRORS.E_INVALID_JOB_INPUT);
}

// ================= no secret/value echo in errors =================
{
  // an id error must not echo the offending value
  try { assertId("job_SECRETVALUE123", "job"); }
  catch (e) { check("id error does not echo value", JSON.stringify(e.toJSON()).includes("SECRETVALUE"), false); }
  // a dangerous-field error names the field, not a secret value
  try { validateJobInput("EXPORT_PROJECT", { projectId: IDS.prj, episodeId: IDS.ep, token: "sk-supersecret-123" }); }
  catch (e) { check("dangerous error does not echo secret", JSON.stringify(e.toJSON()).includes("sk-supersecret"), false); }
}

// ================= heartbeat period is remote input =================
// The period arrives in the server's WELCOME frame. A floor alone looked sufficient and was not: Node
// cannot represent a delay above 2^31-1 ms and does not reject one — it warns and falls back to 1 ms. So
// `Math.max(5000, x)` turned a slow heartbeat into a flood for exactly the values the floor was supposed
// to defend against.
{
  check("heartbeat keeps a normal server value", resolveHeartbeatIntervalMs(20_000), 20_000);
  check("heartbeat keeps the gateway maximum", resolveHeartbeatIntervalMs(120_000), 120_000);
  check("heartbeat floors a too-small value", resolveHeartbeatIntervalMs(10), HEARTBEAT_INTERVAL_MIN_MS);
  check("heartbeat caps a value that would overflow to 1ms", resolveHeartbeatIntervalMs(2 ** 31), HEARTBEAT_INTERVAL_MAX_MS);
  check("heartbeat caps an absurd value", resolveHeartbeatIntervalMs(3e9), HEARTBEAT_INTERVAL_MAX_MS);
  check("heartbeat rejects a non-numeric value", resolveHeartbeatIntervalMs("soon"), HEARTBEAT_INTERVAL_DEFAULT_MS);
  check("heartbeat rejects Infinity", resolveHeartbeatIntervalMs(Infinity), HEARTBEAT_INTERVAL_DEFAULT_MS);
  check("heartbeat rejects a negative value", resolveHeartbeatIntervalMs(-1), HEARTBEAT_INTERVAL_DEFAULT_MS);
  check("heartbeat defaults on a missing value", resolveHeartbeatIntervalMs(undefined), HEARTBEAT_INTERVAL_DEFAULT_MS);
  check("heartbeat result is always a safe integer delay",
    [0, 1, 5e3, 1e6, 2 ** 40, NaN, null, "x"].every((v) => {
      const r = resolveHeartbeatIntervalMs(v);
      return Number.isInteger(r) && r >= HEARTBEAT_INTERVAL_MIN_MS && r <= HEARTBEAT_INTERVAL_MAX_MS;
    }));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
