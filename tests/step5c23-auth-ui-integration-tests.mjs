// P0 Step 5C.23 — native-auth UI ↔ transport END-TO-END against the REAL AuthService + disposable PostgreSQL.
// Drives HTTP-shaped requests through createAuthHttpHandler for the NEW surfaces this increment adds: the
// one-time owner bootstrap (status/begin/confirm -> __Host session + csrf cookies), invitation inspect +
// accept, and the security-settings re-auth -> regenerate-recovery flow, plus the CSRF + bootstrap-flag gates.
// SKIPS without portable PostgreSQL. NEVER touches production.

import { Client } from "pg";
import { startDisposablePg, livePgAvailable } from "./helpers/step5c9e-live-pg.mjs";
import { migrate as mrun, MIGRATIONS_DIR, loadMigrationFiles } from "../control-plane/src/persistence/postgres/migrations.mjs";
import { createPostgresAdapter } from "../control-plane/src/persistence/postgres/adapter.mjs";
import { loadConfig } from "../control-plane/src/config/config.mjs";
import { setAuthContext } from "../control-plane/src/auth/auth-context.mjs";
import { createAuthService } from "../control-plane/src/auth/auth-service.mjs";
import { AUTH_CONFIG_DEFAULTS } from "../control-plane/src/auth/auth-config.mjs";
import { createAuthHttpHandler, SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER } from "../control-plane/src/auth/http/auth-http.mjs";
import { userRepository, workspaceRepository } from "../control-plane/src/persistence/repositories/auth-identity-repository.mjs";
import { credentialRepository, mfaRepository, recoveryCodeRepository } from "../control-plane/src/persistence/repositories/auth-credential-repository.mjs";
import { userSessionRepository } from "../control-plane/src/persistence/repositories/auth-session-repository.mjs";
import { preAuthChallengeRepository, passwordResetTokenRepository, emailVerificationTokenRepository, invitationRepository, reauthProofRepository, notificationOutboxRepository, bootstrapTokenRepository, bootstrapCeremonyRepository } from "../control-plane/src/persistence/repositories/auth-token-repository.mjs";
import { securityRepository } from "../control-plane/src/persistence/repositories/auth-security-repository.mjs";
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy } from "../lib/auth/password.mjs";
import { generateToken, hashToken } from "../lib/auth/tokens.mjs";
import { verifyTotp, generateTotp, generateTotpSecret, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash } from "../lib/auth/recovery-codes.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed += 1; else { failed += 1; console.log("FAIL", n); } };
const ORIGIN = "https://studio.example.com";
const secretOf = (uri) => { const m = /[?&]secret=([A-Za-z2-7]+)/.exec(String(uri || "")); return m ? m[1] : null; };
// Escape the whole regex metacharacter set, backslash included and first. The old list was [.$*], which
// happens to cover the cookie names in use ("__Host-..." needs none of it) but silently builds a different
// pattern than intended for anything else — and an unescaped backslash would corrupt the escapes themselves.
const escapeRegExp = (s) => String(s).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
const cookieVal = (setCookie, name) => { for (const c of [].concat(setCookie || [])) { const m = new RegExp(`${escapeRegExp(name)}=([^;]*)`).exec(String(c)); if (m && m[1]) return m[1]; } return null; };

async function main() {
  if (!livePgAvailable()) { console.log("Step 5C.23 auth ui integration: SKIPPED (portable PostgreSQL not available)"); return; }
  const live = await startDisposablePg({ namePrefix: "cp5c23ui" });
  const mc = new Client({ connectionString: live.migrationUrl }); await mc.connect();
  try { await mrun(mc, { dir: MIGRATIONS_DIR }); check("migrations apply to latest", (await mc.query("SELECT max(version)::int mx FROM cp_schema_migrations")).rows[0].mx === loadMigrationFiles(MIGRATIONS_DIR).length); } finally { await mc.end(); }
  const adapter = createPostgresAdapter(loadConfig({ CONTROL_PLANE_DB_ENABLED: "true", CONTROL_PLANE_DB_URL: live.appUrl, CONTROL_PLANE_DB_OPS_URL: live.opsUrl }), {});
  await adapter.start();
  let clock = Date.parse("2026-07-23T12:00:00.000Z");
  const key = generateSecretBoxKey();
  const svc = createAuthService({
    persistence: adapter, setAuthContext,
    repos: { user: userRepository, workspace: workspaceRepository, credential: credentialRepository, mfa: mfaRepository, recovery: recoveryCodeRepository, session: userSessionRepository, preAuth: preAuthChallengeRepository, reauth: reauthProofRepository, resetToken: passwordResetTokenRepository, verifyToken: emailVerificationTokenRepository, invitation: invitationRepository, notification: notificationOutboxRepository, security: securityRepository, bootstrap: bootstrapCeremonyRepository, bootstrapToken: bootstrapTokenRepository },
    hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, generateToken, hashToken, verifyTotp,
    decryptTotpSecret: (ct) => decryptSecret(ct, key), generateTotpSecret, otpauthUrl, encryptTotpSecret: (s) => encryptSecret(s, key),
    generateRecoveryCodes, hashRecoveryCode, matchRecoveryHash, encryptLinkToken: (t) => encryptSecret(t, key),
    clock: () => clock, config: AUTH_CONFIG_DEFAULTS
  });
  const cfg = { nativeAuthRoutesEnabled: true, nativeAuthEnforcementEnabled: true, nativeAuthBootstrapEnabled: true, allowedOrigins: [ORIGIN], cookieSecure: true, hashToken };
  const handler = createAuthHttpHandler({ authService: svc, config: cfg, clock: () => clock });
  const H = (method, path, { body, cookie, csrf, origin = ORIGIN } = {}) => handler.handle({ method, path, ip: "1.1.1.1", headers: { origin, "user-agent": "test", ...(cookie ? { cookie } : {}), ...(csrf ? { [CSRF_HEADER]: csrf } : {}) }, body: body || {} });

  try {
    // ============ owner bootstrap over HTTP ============
    const st0 = await H("GET", "/api/auth/bootstrap/status");
    check("GET bootstrap/status -> REQUIRED + available", st0.status === 200 && st0.body.state === "REQUIRED" && st0.body.available === true);

    const beg = await H("POST", "/api/auth/bootstrap/begin", { body: { email: "owner@studio.test", password: "owner-pass-123456", displayName: "Owner" } });
    check("POST bootstrap/begin -> 200 STARTED + ceremonyToken + otpauthUri", beg.status === 200 && beg.body.result === "OWNER_BOOTSTRAP_STARTED" && typeof beg.body.ceremonyToken === "string" && typeof beg.body.otpauthUri === "string");
    check("bootstrap/begin sets NO session cookie (no session before MFA)", !("Set-Cookie" in beg.headers));
    check("bootstrap/begin never leaks a session/csrf token in the body", !("sessionToken" in beg.body) && !("csrfHash" in beg.body));

    const bootSecret = secretOf(beg.body.otpauthUri);
    const badConfirm = await H("POST", "/api/auth/bootstrap/confirm", { body: { ceremonyToken: beg.body.ceremonyToken, code: "000000" } });
    check("bootstrap/confirm wrong code -> 401 (retryable)", badConfirm.status === 401 && badConfirm.body.result === "AUTHENTICATION_FAILED");

    const conf = await H("POST", "/api/auth/bootstrap/confirm", { body: { ceremonyToken: beg.body.ceremonyToken, code: generateTotp(bootSecret, { nowMs: clock }) } });
    check("bootstrap/confirm -> 200 SESSION_ISSUED + recovery codes", conf.status === 200 && conf.body.result === "SESSION_ISSUED" && Array.isArray(conf.body.recoveryCodes) && conf.body.recoveryCodes.length === 10);
    check("bootstrap/confirm sets __Host session + csrf cookies", cookieVal(conf.headers["Set-Cookie"], SESSION_COOKIE) && cookieVal(conf.headers["Set-Cookie"], CSRF_COOKIE));
    check("bootstrap/confirm never puts the session token in the body", !("sessionToken" in conf.body));
    const ownerCookie = `${SESSION_COOKIE}=${cookieVal(conf.headers["Set-Cookie"], SESSION_COOKIE)}`;
    const ownerCsrf = conf.body.csrfToken;

    check("GET bootstrap/status after completion -> COMPLETED + unavailable", (await H("GET", "/api/auth/bootstrap/status")).body.state === "COMPLETED");
    check("bootstrap/begin after completion -> 409 unavailable", (await H("POST", "/api/auth/bootstrap/begin", { body: { email: "x@studio.test", password: "x-owner-pass-123456" } })).status === 409);

    // ============ security settings: reauth -> regenerate recovery ============
    check("GET mfa/status (owner cookie) -> active TOTP", (await H("GET", "/api/auth/mfa/status", { cookie: ownerCookie })).body.methods.some((m) => m.status === "ACTIVE"));
    check("GET recovery/status -> 10 unused", (await H("GET", "/api/auth/recovery/status", { cookie: ownerCookie })).body.unusedCount === 10);
    // a mutation WITHOUT csrf -> 403 (double-submit enforced)
    check("recovery/regenerate without csrf -> 403", (await H("POST", "/api/auth/recovery/regenerate", { cookie: ownerCookie, body: { reauthToken: "x" } })).status === 403);
    const rb = await H("POST", "/api/auth/reauth/begin", { cookie: ownerCookie, csrf: ownerCsrf, body: { action: "REGENERATE_RECOVERY", method: "PASSWORD" } });
    check("reauth/begin -> reauthToken", rb.status === 200 && typeof rb.body.reauthToken === "string");
    const rp = await H("POST", "/api/auth/reauth/password", { cookie: ownerCookie, csrf: ownerCsrf, body: { reauthToken: rb.body.reauthToken, password: "owner-pass-123456" } });
    check("reauth/password -> OK", rp.status === 200 && rp.body.ok === true);
    const regen = await H("POST", "/api/auth/recovery/regenerate", { cookie: ownerCookie, csrf: ownerCsrf, body: { reauthToken: rb.body.reauthToken } });
    check("recovery/regenerate (with csrf + verified reauth) -> 10 fresh codes", regen.status === 200 && Array.isArray(regen.body.recoveryCodes) && regen.body.recoveryCodes.length === 10 && !regen.body.recoveryCodes.includes(conf.body.recoveryCodes[0]));
    // reusing the SAME reauth proof for another sensitive action fails (one-time, action-bound)
    check("reauth proof is one-time -> reused regenerate -> 403", (await H("POST", "/api/auth/recovery/regenerate", { cookie: ownerCookie, csrf: ownerCsrf, body: { reauthToken: rb.body.reauthToken } })).status === 403);

    // ============ invitation inspect (non-consuming) + accept ============
    const wsId = conf.body.workspaceId;
    const inviteToken = generateToken(32);
    await adapter.transaction(async (c) => { await setAuthContext(c, { workspaceId: wsId }); await invitationRepository.createInvitation(c, { workspaceId: wsId, email: "invitee@studio.test", role: "MEMBER", tokenHash: hashToken(inviteToken), expiresAt: new Date(clock + 7 * 864e5), invitedBy: null }); });
    const insp = await H("POST", "/api/auth/invitations/inspect", { body: { token: inviteToken } });
    check("invitations/inspect -> workspace + role + MASKED email", insp.status === 200 && insp.body.ok === true && insp.body.role === "MEMBER" && /\*\*\*/.test(insp.body.maskedEmail) && !String(insp.body.maskedEmail).includes("invitee@studio.test"));
    check("invitations/inspect for a bogus token -> generic { ok:false }", (await H("POST", "/api/auth/invitations/inspect", { body: { token: "nope" } })).body.ok === false);
    const acc = await H("POST", "/api/auth/invitations/accept", { body: { token: inviteToken, password: "invitee-pass-123456", displayName: "Invitee" } });
    check("invitations/accept (MEMBER, no MFA) -> 200 SESSION_ISSUED + cookie", acc.status === 200 && acc.body.result === "SESSION_ISSUED" && cookieVal(acc.headers["Set-Cookie"], SESSION_COOKIE));

    // ============ bootstrap flag gate: routes 404 when the deploy flag is OFF ============
    const noBootHandler = createAuthHttpHandler({ authService: svc, config: { ...cfg, nativeAuthBootstrapEnabled: false }, clock: () => clock });
    const gated = await noBootHandler.handle({ method: "GET", path: "/api/auth/bootstrap/status", headers: { origin: ORIGIN }, body: {} });
    check("bootstrap route with deploy flag OFF -> 404 (closed)", gated.status === 404);

    // ============ owner can log in again through the normal MFA path ============
    clock += 60_000; // advance past the TOTP timestep used at bootstrap so a fresh code is not a replay
    const login = await H("POST", "/api/auth/login", { body: { email: "owner@studio.test", password: "owner-pass-123456" } });
    check("owner login -> MFA_REQUIRED (owner has active TOTP)", login.status === 200 && login.body.result === "MFA_REQUIRED" && typeof login.body.challengeToken === "string");
    const mfa = await H("POST", "/api/auth/mfa/complete", { body: { challengeToken: login.body.challengeToken, code: generateTotp(bootSecret, { nowMs: clock }) } });
    check("owner mfa/complete -> SESSION_ISSUED + cookie", mfa.status === 200 && mfa.body.result === "SESSION_ISSUED" && cookieVal(mfa.headers["Set-Cookie"], SESSION_COOKIE));
  } finally { await adapter.stop().catch(() => {}); }

  console.log(`Step 5C.23 auth ui integration: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.log("FATAL", e && e.stack || e); process.exit(1); });
