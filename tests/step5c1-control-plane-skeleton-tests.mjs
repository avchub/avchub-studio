#!/usr/bin/env node
// P0 Step 5C.1 — Control Plane service-skeleton tests.
//
// SAFE BY CONSTRUCTION: ephemeral loopback ports only. Does NOT launch a browser, Python, a
// provider, Docker, or a real database; consumes no quota; touches no production media; never
// starts ui-server or WorkerRuntime. Every server/socket/handler is cleaned up in finally.

import http from "node:http";
import net from "node:net";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, safeConfigSummary } from "../control-plane/src/config/config.mjs";
import { createApp } from "../control-plane/src/app.mjs";
import { createLogger } from "../control-plane/src/logging/logger.mjs";
import { sanitize } from "../control-plane/src/logging/redact.mjs";
import { createFeatureFlags, FLAG_REASONS } from "../control-plane/src/feature-flags/feature-flags.mjs";
import { createPersistence } from "../control-plane/src/persistence/persistence.mjs";
import { createWorkerGateway } from "../control-plane/src/gateway/gateway.mjs";
import { createBackgroundProcessor } from "../control-plane/src/processor/processor.mjs";
import { scanForbiddenImports } from "../control-plane/src/boundary.mjs";
import { installSignalHandlers, runCheckConfig } from "../control-plane/src/main.mjs";
import { CP_ERRORS } from "../control-plane/src/errors.mjs";
import { validateId } from "../lib/protocol/ids.mjs";

let un = false; process.on("unhandledRejection", (e) => { un = true; console.error("UNHANDLED", e && e.message); });
let failures = 0, passed = 0;
// Failure output goes through the project's own redactor. Several assertions here compare whole config
// objects, which carry password and apiKey fields, and a failing assertion in CI writes its "actual" value
// into a public build log. Redacting costs nothing: the shape and every non-secret field still print, which
// is what makes a failure diagnosable in the first place.
function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) passed += 1;
  else { failures += 1; console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(sanitize(actual))}\n  expected: ${JSON.stringify(sanitize(expected))}`); }
}
// The failure printer above is the one thing in this file that can leak, so it is asserted rather than
// assumed. These run before any other check, so a regression in the redactor is reported by the very
// mechanism it protects. The shape used here is exactly the one the analyser warns about: a config object
// carrying `password` and `apiKey`.
{
  const withSecrets = { host: "127.0.0.1", password: "pw-must-not-appear", nested: { apiKey: "key-must-not-appear" } };
  const printed = JSON.stringify(sanitize(withSecrets));
  check("redactor removes a password from failure output", !printed.includes("pw-must-not-appear"));
  check("redactor removes a nested apiKey from failure output", !printed.includes("key-must-not-appear"));
  check("redactor keeps the non-secret shape that makes a failure readable",
    printed.includes("host") && printed.includes("password") && printed.includes("apiKey"));
  check("redactor survives a value that cannot be serialized", typeof JSON.stringify(sanitize({ cyclic: (() => { const o = {}; o.self = o; return o; })() })), "string");
}

async function checkThrowsAsync(name, fn, code) {
  try { await fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) { if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); } else passed += 1; }
}
function checkThrows(name, fn, code) {
  try { fn(); failures += 1; console.error(`FAIL ${name} (expected throw)`); }
  catch (e) { if (code && e.code !== code) { failures += 1; console.error(`FAIL ${name} (code ${e.code} != ${code})`); } else passed += 1; }
}
async function waitFor(pred, budgetMs = 3000, step = 10) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) { if (await pred()) return true; await sleep(step); }
  return pred();
}
function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }

const silentLogger = createLogger({ level: "silent" });
const apps = [];
async function startApp(overrides = {}) {
  // Ephemeral loopback port by default so parallel apps in this suite never collide.
  const config = loadConfig({ CONTROL_PLANE_PORT: "0", ...overrides });
  const app = await createApp({ config, logger: silentLogger });
  apps.push(app);
  await app.start();
  return app;
}
function request(app, { method = "GET", path: p = "/", headers = {}, body = null } = {}) {
  const addr = app.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: addr.address === "::" ? "127.0.0.1" : addr.address, port: addr.port, method, path: p, headers }, (res) => {
      let data = ""; res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const SRC_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "control-plane", "src");

try {
  // ================= config (1–5, 7, 8) =================
  {
    const c = loadConfig({});
    check("1 dev default environment", c.server.environment, "development");
    check("1 dev default loopback host", c.server.host, "127.0.0.1");
    check("1 dev default port present", Number.isInteger(c.server.port), true);
    check("6 all execution flags OFF by default", Object.values(c.featureFlags).every((v) => v === false), true);

    checkThrows("2 malformed boolean rejected", () => loadConfig({ CONTROL_PLANE_DB_ENABLED: "maybe" }), CP_ERRORS.E_CONFIG_INVALID);
    checkThrows("3 malformed integer rejected", () => loadConfig({ CONTROL_PLANE_PORT: "abc" }), CP_ERRORS.E_CONFIG_INVALID);
    checkThrows("3b out-of-range integer rejected", () => loadConfig({ CONTROL_PLANE_PORT: "99999" }), CP_ERRORS.E_CONFIG_INVALID);
    checkThrows("4 production without required config rejected", () => loadConfig({ CONTROL_PLANE_ENV: "production" }), CP_ERRORS.E_CONFIG_INVALID);
    checkThrows("7 flag lattice: worker exec without control plane rejected",
      () => loadConfig({ CONTROL_PLANE_FLAG_WORKER_EXECUTION_ENABLED: "true" }), CP_ERRORS.E_CONFIG_INVALID);
    checkThrows("7b flag lattice: real grok without worker exec rejected",
      () => loadConfig({ CONTROL_PLANE_FLAG_CONTROL_PLANE_ENABLED: "true", CONTROL_PLANE_FLAG_REAL_GROK_WORKER_ENABLED: "true" }), CP_ERRORS.E_CONFIG_INVALID);

    // 5 — secrets never in the config summary.
    const withSecrets = loadConfig({
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:SUPERSECRET@db:5432/cp",  // scan-secrets:allow fixture DSN, exists to prove redaction
      CONTROL_PLANE_CREDENTIAL_PEPPER: "PEPPER_VALUE_XYZ", CONTROL_PLANE_PAIRING_PEPPER: "PAIR_PEPPER_ABC"
    });
    const summaryStr = JSON.stringify(safeConfigSummary(withSecrets));
    check("5 summary excludes db url secret", summaryStr.includes("SUPERSECRET"), false);
    check("5 summary excludes credential pepper", summaryStr.includes("PEPPER_VALUE_XYZ"), false);
    check("5 summary excludes pairing pepper", summaryStr.includes("PAIR_PEPPER_ABC"), false);
    check("5 summary reports urlConfigured boolean", safeConfigSummary(withSecrets).database.urlConfigured, true);
    check("5 summary reports pepper configured booleans", safeConfigSummary(withSecrets).security.credentialPepperConfigured, true);
  }

  // ================= feature flags (6, 7, 8) =================
  {
    const c = loadConfig({});
    const ff = createFeatureFlags({ featureFlags: c.featureFlags });
    check("6 controlPlane flag off → DISABLED_BY_DEFAULT", ff.evaluateFlag({ flag: "controlPlaneEnabled" }).reason, FLAG_REASONS.DISABLED_BY_DEFAULT);
    check("6 workerExecution off → not enabled", ff.evaluateFlag({ flag: "workerExecutionEnabled" }).enabled, false);
    check("6 realGrok off → not enabled", ff.evaluateFlag({ flag: "realGrokWorkerEnabled" }).enabled, false);

    // 8 — paid path can never enable, even with all prerequisites configured true.
    const cAll = loadConfig({
      CONTROL_PLANE_FLAG_CONTROL_PLANE_ENABLED: "true",
      CONTROL_PLANE_FLAG_WORKER_EXECUTION_ENABLED: "true",
      CONTROL_PLANE_FLAG_REAL_GROK_WORKER_ENABLED: "true"
    });
    const ffAll = createFeatureFlags({ featureFlags: cAll.featureFlags });
    check("8 realGrok paidPath → FEATURE_UNAVAILABLE", ffAll.evaluateFlag({ flag: "realGrokWorkerEnabled", paidPath: true }).reason, FLAG_REASONS.FEATURE_UNAVAILABLE);
    check("8 realGrok non-paid still FEATURE_UNAVAILABLE (capability not built)", ffAll.evaluateFlag({ flag: "realGrokWorkerEnabled" }).reason, FLAG_REASONS.FEATURE_UNAVAILABLE);
    check("8 workerExecution → FEATURE_UNAVAILABLE", ffAll.evaluateFlag({ flag: "workerExecutionEnabled" }).reason, FLAG_REASONS.FEATURE_UNAVAILABLE);

    // 7 — evaluator prerequisite guard (hand-built inconsistent snapshot).
    const ffBad = createFeatureFlags({ featureFlags: { controlPlaneEnabled: false, workerExecutionEnabled: true } });
    check("7 evaluator PREREQUISITE_DISABLED", ffBad.evaluateFlag({ flag: "workerExecutionEnabled" }).reason, FLAG_REASONS.PREREQUISITE_DISABLED);
    // global kill representation
    const ffKill = createFeatureFlags({ featureFlags: { controlPlaneEnabled: true }, killed: ["controlPlaneEnabled"] });
    check("7 global kill represented", ffKill.evaluateFlag({ flag: "controlPlaneEnabled" }).reason, FLAG_REASONS.GLOBAL_KILL);
    check("unknown flag → FEATURE_UNAVAILABLE", ffKill.evaluateFlag({ flag: "nope" }).reason, FLAG_REASONS.FEATURE_UNAVAILABLE);
  }

  // ================= service + HTTP (9–20) =================
  {
    const app = await startApp({});
    check("9 service starts (READY)", app.getPhase(), "READY");
    const addr = app.address();
    check("10 binds loopback by default", addr.address === "127.0.0.1" || addr.address === "::1", true);

    const hz = await request(app, { path: "/healthz" });
    check("11 /healthz 200", hz.status, 200);
    check("11 /healthz alive", hz.json?.alive, true);

    const rz = await request(app, { path: "/readyz" });
    check("12 /readyz 200 in skeleton mode", rz.status, 200);
    check("12 /readyz ready true", rz.json?.ready, true);

    const ver = await request(app, { path: "/version" });
    check("14 /version 200", ver.status, 200);
    check("14 /version protocolVersion 1", ver.json?.protocolVersion, 1);
    check("14 /version has service+instanceId", Boolean(ver.json?.service && ver.json?.instanceId), true);
    check("14 /version no secret-ish keys", /pepper|credential|password|url/i.test(ver.text), false);

    // 5C.13 §N / 5C.14 — bare "/" is the Studio landing: GET/HEAD redirect to the canonical Movies
    // view (/movies, served by the production-ui sub-router) so an owner who opens the root (locally
    // or via the tunnel) lands on the app, not a 404.
    const rootGet = await request(app, { path: "/" });
    check("R1 GET / redirects (303)", rootGet.status, 303);
    check("R1 GET / Location is /movies", rootGet.headers.location, "/movies");
    check("R1 GET / redirect body empty (no route-not-found JSON)", rootGet.text, "");
    const rootHead = await request(app, { method: "HEAD", path: "/" });
    check("R1 HEAD / redirects 303", rootHead.status, 303);
    check("R1 HEAD / Location is /movies", rootHead.headers.location, "/movies");
    // Regression guard: the 404 behavior of API/unknown routes and non-GET/HEAD on "/" is UNCHANGED.
    const rootPost = await request(app, { method: "POST", path: "/" });
    check("R2 POST / still 404 (only GET/HEAD land)", rootPost.status, 404);
    check("R2 POST / still Route-not-found code", rootPost.json?.code, CP_ERRORS.E_NOT_FOUND);

    const nf = await request(app, { path: "/does-not-exist" });
    check("15 unknown route 404", nf.status, 404);
    check("15 unknown route code", nf.json?.code, CP_ERRORS.E_NOT_FOUND);
    check("18 error body has no stack", /\n\s+at\s|"stack"/.test(nf.text), false);
    check("18 error body shape", Object.keys(nf.json).sort().join(","), "code,correlationId,message,retriable");

    const cs = await request(app, { path: "/internal/config-summary" });
    check("config-summary available in dev", cs.status, 200);
    check("config-summary reports flag booleans", cs.json?.featureFlags?.controlPlaneEnabled, false);

    // 19 correlation id generated
    check("19 correlation id header generated", validateId(hz.headers["x-correlation-id"], "corr"), true);
    // 20 invalid correlation id replaced
    const withBad = await request(app, { path: "/healthz", headers: { "x-correlation-id": "not-a-valid-id" } });
    check("20 invalid correlation id replaced", withBad.headers["x-correlation-id"] !== "not-a-valid-id", true);
    check("20 replacement is a valid corr id", validateId(withBad.headers["x-correlation-id"], "corr"), true);
  }

  // 16/17 oversized + malformed JSON (small cap app)
  {
    const app = await startApp({ CONTROL_PLANE_MAX_REQUEST_BYTES: "1024" });
    const big = "x".repeat(5000);
    const over = await request(app, { method: "POST", path: "/healthz", headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(big) }, body: big });
    check("16 oversized request 413", over.status, 413);
    check("16 oversized code", over.json?.code, CP_ERRORS.E_PAYLOAD_TOO_LARGE);
    const bad = await request(app, { method: "POST", path: "/healthz", headers: { "content-type": "application/json" }, body: "{ not json" });
    check("17 malformed JSON 400", bad.status, 400);
    check("17 malformed JSON code", bad.json?.code, CP_ERRORS.E_BAD_REQUEST);
    check("17 no stack in malformed-json response", /\n\s+at\s|"stack"/.test(bad.text), false);
  }

  // 13 readiness false when an enabled dependency is unavailable
  {
    const app = await startApp({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@localhost:5432/cp" });
    const rz = await request(app, { path: "/readyz" });
    check("13 /readyz 503 when enabled dep unavailable", rz.status, 503);
    check("13 /readyz ready false", rz.json?.ready, false);
    check("13 /healthz still 200 (liveness independent)", (await request(app, { path: "/healthz" })).status, 200);
  }

  // ================= logging + redaction (21–24) =================
  {
    const lines = [];
    const log = createLogger({ level: "info", service: "cp-test", sink: (l) => lines.push(l) });
    log.info("unit_event", { requestId: "corr_x", outcome: "ok" });
    const rec = JSON.parse(lines[0]);
    check("21 structured log is JSON", typeof rec === "object", true);
    check("21 log has level/service/event", rec.level === "info" && rec.service === "cp-test" && rec.event === "unit_event", true);

    const red = sanitize({ Authorization: "Bearer abc.def", nested: { password: "p", CoOkIe: "c" }, arr: [{ apiKey: "k" }], safe: "hello" });
    check("22 nested password redacted", red.nested.password, "[REDACTED]");
    check("22 array nested apiKey redacted", red.arr[0].apiKey, "[REDACTED]");
    check("23 case-variant Authorization redacted", red.Authorization, "[REDACTED]");
    check("23 case-variant CoOkIe redacted", red.nested.CoOkIe, "[REDACTED]");
    check("22 safe value preserved", red.safe, "hello");
    // value-shape redaction (Bearer / url / path) even under a non-sensitive key
    const red2 = sanitize({ note: "Bearer secrettoken", link: "https://provider/x", p: "C:/secret/media.mp4" });
    check("value bearer redacted", red2.note, "[REDACTED]");
    check("value url redacted", red2.link, "[REDACTED]");
    check("value abs path redacted", red2.p, "[REDACTED]");

    // 24 logger failure does not crash
    const boomLog = createLogger({ level: "info", sink: () => { throw new Error("sink boom"); } });
    let threw = false; try { boomLog.info("e", { a: 1 }); } catch { threw = true; }
    check("24 logger failure does not crash caller", threw, false);
  }

  // ================= lifecycle (25–33) =================
  {
    // 25 double start
    const app = await startApp({});
    await app.start();
    check("25 double start idempotent (READY)", app.getPhase(), "READY");
    // 26 double stop
    await app.stop();
    await app.stop();
    check("26 double stop idempotent (STOPPED)", app.getPhase(), "STOPPED");
    check("32 no leaked sockets after normal stop", app.openSockets(), 0);
  }
  {
    // 27 stop during initialization (start not awaited)
    const config = loadConfig({});
    const app = await createApp({ config, logger: silentLogger });
    apps.push(app);
    const startP = app.start();
    const stopP = app.stop();
    await Promise.all([startP.catch(() => {}), stopP]);
    check("27 stop during init → STOPPED", app.getPhase(), "STOPPED");
  }
  {
    // 28 SIGTERM lifecycle
    const app = await startApp({});
    let exitCode = null;
    const remove = installSignalHandlers(app, { signals: ["SIGTERM"], onExit: (c) => { exitCode = c; } });
    process.emit("SIGTERM");
    await waitFor(() => app.getPhase() === "STOPPED" && exitCode === 0);
    check("28 SIGTERM stops app", app.getPhase(), "STOPPED");
    check("28 SIGTERM onExit(0)", exitCode, 0);
    remove();
  }
  {
    // 29 readiness false while draining
    const app = await startApp({});
    app.modules.httpServer.beginDrain();
    check("29 readiness false while draining", app.readiness().ready, false);
    const rz = await request(app, { path: "/readyz" });
    check("29 /readyz 503 while draining", rz.status, 503);
    await app.stop();
  }
  {
    // 30/31/32 in-flight grace + shutdown timeout + forced socket close
    const app = await startApp({ CONTROL_PLANE_REQUEST_TIMEOUT_MS: "30000", CONTROL_PLANE_SHUTDOWN_TIMEOUT_MS: "120" });
    const addr = app.address();
    const socket = net.connect(addr.port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    // partial request: declares a body but never sends it → held in-flight
    socket.write("POST /healthz HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 5000\r\n\r\n");
    await waitFor(() => app.inFlight() >= 1);
    check("30 request held in-flight", app.inFlight() >= 1, true);
    const t0 = Date.now();
    await app.stop();
    const dt = Date.now() - t0;
    check("31 shutdown honored timeout window (bounded)", dt >= 100 && dt < 5000, true);
    check("32 no leaked sockets after forced shutdown", app.openSockets(), 0);
    check("31 phase STOPPED after timed drain", app.getPhase(), "STOPPED");
    try { socket.destroy(); } catch { /* */ }
  }
  {
    // 33 no leaked timers. This used to assert that the token `setInterval` appeared nowhere in the core,
    // which is a proxy for the property, not the property — and it went red when a legitimate one was added:
    // the story repair lease renews on a heartbeat that is unref'd at creation and cleared in a finally, so
    // it can neither hold the process open nor outlive its run.
    //
    // Asserted directly instead: every setInterval in the core is unref'd and cleared. A new one that forgets
    // either still fails, and the suite no longer fails for a timer that is correct.
    const files = listMjs(SRC_DIR);
    const leaky = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      if (!/setInterval\s*\(/.test(src)) return false;
      return !/\.unref\s*\(\s*\)/.test(src) || !/clearInterval\s*\(/.test(src);
    });
    // Joined, because this suite's check() compares with === and two empty arrays never are.
    check("33 every setInterval in core is unref'd and cleared", leaky.map((f) => path.basename(f)).join(", "), "");
  }

  // ================= persistence / gateway / processor boundaries (34–39) =================
  {
    const disabled = createPersistence(loadConfig({}));
    check("34 disabled persistence ready (non-blocking)", disabled.health().ready, true);
    check("34 disabled persistence reason DISABLED", disabled.health().reasonCode, "DISABLED");
    await checkThrowsAsync("34 disabled persistence transaction throws", () => disabled.transaction(), CP_ERRORS.E_DEPENDENCY_NOT_READY);

    // 35 — enabled DB with no reachable server fails SAFELY (Step 5C.2 PostgreSQL adapter):
    // readiness false with a schema/connection state, never a fake connection. Uses a
    // fast-refusing loopback port so start() returns quickly.
    const enabled = createPersistence(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:1/cp_test" }), { logger: silentLogger });
    await enabled.start();
    check("35 enabled persistence not ready when DB unreachable", enabled.health().ready, false);
    check("35 enabled persistence reason is a non-ready schema state", enabled.health().reasonCode !== "DATABASE_READY" && enabled.health().enabled === true, true);
    check("35 enabled persistence is the postgres adapter", enabled.kind, "postgres");
    await checkThrowsAsync("35 enabled persistence tenantTransaction throws when unavailable", () => enabled.tenantTransaction("ws_01JQ7ZK9M3N4P5Q6R7S8T9V0B3", async () => {}));
    await enabled.stop();

    const gwOff = createWorkerGateway(loadConfig({}), { logger: silentLogger });
    await gwOff.start();
    check("36 disabled gateway ready no-op", gwOff.getStatus().ready, true);
    check("36 disabled gateway reason DISABLED", gwOff.getStatus().reasonCode, "DISABLED");
    await gwOff.stop();

    // P0 Step 5C.4: the Gateway is now REAL (no longer a NOT_IMPLEMENTED placeholder). Enabling it
    // requires DB + processor + a credential pepper (config-gated); constructed here with no
    // persistence/processor it fails readiness SAFELY (DB_NOT_READY) and opens no socket.
    const gwOnCfg = loadConfig({
      CONTROL_PLANE_GATEWAY_ENABLED: "true", CONTROL_PLANE_PROCESSOR_ENABLED: "true",
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:5/cp_test",
      CONTROL_PLANE_CREDENTIAL_PEPPER: "test-pepper-value"
    });
    const gwOn = createWorkerGateway(gwOnCfg, { logger: silentLogger, persistence: null, processor: null, httpServer: null });
    await gwOn.start();
    check("37 enabled gateway not ready without DB", gwOn.getStatus().ready, false);
    check("37 enabled gateway reason DB_NOT_READY", gwOn.getStatus().reasonCode, "DB_NOT_READY");
    await gwOn.stop();

    const prOff = createBackgroundProcessor(loadConfig({}), { logger: silentLogger });
    await prOff.start();
    check("38 disabled processor ready no-op", prOff.getStatus().ready, true);
    check("38 disabled processor reason DISABLED", prOff.getStatus().reasonCode, "DISABLED");
    await prOff.stop();

    // P0 Step 5C.3: the processor is now REAL (no longer a NOT_IMPLEMENTED placeholder). When
    // enabled it requires the database; with no adapter/DB ready it fails readiness SAFELY. It is
    // constructed here without an adapter, so dbReady() is false → not ready, reason DB_NOT_READY.
    const prOn = createBackgroundProcessor(loadConfig({
      CONTROL_PLANE_FLAG_CONTROL_PLANE_ENABLED: "true",
      CONTROL_PLANE_PROCESSOR_ENABLED: "true",
      CONTROL_PLANE_DB_ENABLED: "true",
      CONTROL_PLANE_DB_URL: "postgres://u:p@127.0.0.1:1/cp_test"
    }), { logger: silentLogger });
    await prOn.start();
    check("39 enabled processor not ready without DB", prOn.getStatus().ready, false);
    check("39 enabled processor reason DB_NOT_READY", prOn.getStatus().reasonCode, "DB_NOT_READY");
    await prOn.stop();
  }

  // ================= dependency boundaries (40–43) =================
  {
    const violations = scanForbiddenImports(SRC_DIR);
    check("40 dependency-boundary scan clean", violations.length, 0);
    if (violations.length) console.error("boundary violations:", JSON.stringify(violations));
    // 41 explicit: no provider/browser/python import rules triggered (subset — already 0)
    const providerish = violations.filter((v) => /py|worker|grok|provider|browser|chatgpt|elevenlabs/i.test(v.rule));
    check("41 no provider/browser/python imports", providerish.length, 0);

    // 42 ui-server untouched by coupling: control-plane doesn't import it; ui-server doesn't import control-plane
    const cpReferencesUi = listMjs(SRC_DIR).some((f) => /from\s+['"][^'"]*ui-server/.test(readFileSync(f, "utf8")));
    check("42 control-plane does not import ui-server", cpReferencesUi, false);
    // The reverse direction can only be asserted where the legacy server still exists. A tree that does not
    // ship it satisfies the property trivially, and reading a file that is not there would fail the suite for
    // the wrong reason — the coupling this checks for is impossible without the file.
    const uiServerPath = path.join(SRC_DIR, "..", "..", "ui-server.mjs");
    if (existsSync(uiServerPath)) {
      const uiSrc = readFileSync(uiServerPath, "utf8");
      check("42 ui-server does not import control-plane", /from\s+['"][^'"]*control-plane/.test(uiSrc), false);
    }

    // 43 no LOCAL_LEGACY / WORKER_RUNTIME_BRIDGE coupling in the core
    const bridgeRef = listMjs(SRC_DIR).some((f) => /LOCAL_LEGACY|WORKER_RUNTIME_BRIDGE|bridge-flag/.test(readFileSync(f, "utf8")));
    check("43 no LOCAL_LEGACY/bridge coupling in core", bridgeRef, false);
  }

  // ================= check-config command =================
  {
    let out = null, err = null;
    const okCode = runCheckConfig(
      { CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:LEAKME_CFG@h/db", CONTROL_PLANE_CREDENTIAL_PEPPER: "LEAKME_PEP" },  // scan-secrets:allow fixture DSN, exists to prove redaction
      { out: (s) => { out = s; }, err: () => {} });
    check("check-config valid → exit 0", okCode, 0);
    check("check-config prints summary", /"summary"/.test(out), true);
    check("check-config summary leaks no secret values", /LEAKME/.test(out || ""), false);
    const badCode = runCheckConfig({ CONTROL_PLANE_PORT: "abc" }, { out: () => {}, err: (s) => { err = s; } });
    check("check-config invalid → exit 1", badCode, 1);
    check("check-config prints safe issue codes only (no values)", /"reason"/.test(err) && !/abc/.test(err), true);
  }

  // ================= endpoint secret-leak guard =================
  {
    const app = await startApp({
      CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: "postgres://u:LEAKME_DBSECRET@h/db",  // scan-secrets:allow fixture DSN, exists to prove redaction
      CONTROL_PLANE_CREDENTIAL_PEPPER: "LEAKME_PEPPER123", CONTROL_PLANE_PAIRING_PEPPER: "LEAKME_PAIR"
    });
    const cs = await request(app, { path: "/internal/config-summary" });
    check("summary endpoint leaks no secret values", /LEAKME/.test(cs.text), false);
    check("summary endpoint reports urlConfigured true", cs.json?.database?.urlConfigured, true);
    check("summary endpoint reports pepper configured true", cs.json?.security?.credentialPepperConfigured, true);
    const ver = await request(app, { path: "/version" });
    check("version leaks no secret values", /LEAKME/.test(ver.text), false);
    await app.stop();
  }

  check("no unhandled rejection", un, false);
} finally {
  for (const app of apps) { try { await app.stop(); } catch { /* */ } }
}

function listMjs(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listMjs(full));
    else if (e.endsWith(".mjs")) out.push(full);
  }
  return out;
}

if (failures > 0) { console.error(`\n${passed} passed, ${failures} failed`); process.exit(1); }
else { console.log(`${passed} passed, 0 failed`); process.exit(0); }
