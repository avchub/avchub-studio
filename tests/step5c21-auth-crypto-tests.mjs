// P0 Step 5C.21 — auth crypto primitives (Argon2id password, RFC-6238 TOTP, recovery codes, tokens,
// AES-256-GCM secret box). No DB, no network. Proves the security-critical primitives before any wiring.
import { hashPassword, verifyPassword, needsRehash, validatePasswordPolicy, ARGON2_PARAMS } from "../lib/auth/password.mjs";
import { generateTotpSecret, generateTotp, verifyTotp, base32Encode, base32Decode, otpauthUrl } from "../lib/auth/totp.mjs";
import { generateRecoveryCodes, generateRecoveryCode, hashRecoveryCode, normalizeRecoveryCode, matchRecoveryHash, ALPHABET } from "../lib/auth/recovery-codes.mjs";
import { generateToken, hashToken, tokenHashEquals, issueToken } from "../lib/auth/tokens.mjs";
import { encryptSecret, decryptSecret, generateSecretBoxKey } from "../lib/auth/secret-box.mjs";

let passed = 0, failed = 0;
const check = (n, c) => { if (c) passed++; else { failed++; console.log("FAIL", n); } };
const throwsSync = (n, fn, code) => { try { fn(); failed++; console.log("FAIL(no throw)", n); } catch (e) { if (!code || e.code === code) passed++; else { failed++; console.log("FAIL(code)", n, "got", e.code); } } };

async function run() {
  // ---- A. Argon2id password ----
  const h = await hashPassword("correct horse battery staple");
  check("A hash is argon2id encoded", /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/.test(h));
  check("A verify correct", (await verifyPassword(h, "correct horse battery staple")) === true);
  check("A verify wrong", (await verifyPassword(h, "wrong password xxxx")) === false);
  check("A two hashes of same pw differ (salt)", (await hashPassword("same-password-123")) !== (await hashPassword("same-password-123")));
  check("A policy too short", validatePasswordPolicy("short").code === "PASSWORD_TOO_SHORT");
  check("A policy too long", validatePasswordPolicy("x".repeat(2000)).code === "PASSWORD_TOO_LONG");
  check("A policy ok", validatePasswordPolicy("abcdefghij").ok === true);
  check("A needsRehash weak params", needsRehash("$argon2id$v=19$m=4096,t=1,p=1$aaa$bbb") === true);
  check("A needsRehash current params false", needsRehash(h) === false);
  check("A needsRehash non-argon2 true", needsRehash("$2b$12$abcdef") === true);
  // pepper: a hash made WITH a pepper does not verify WITHOUT it (and vice-versa)
  const pepper = Buffer.from("server-pepper-secret");
  const hp = await hashPassword("pw-with-pepper-xx", { pepper });
  check("A pepper: verifies with pepper", (await verifyPassword(hp, "pw-with-pepper-xx", { pepper })) === true);
  check("A pepper: fails without pepper", (await verifyPassword(hp, "pw-with-pepper-xx")) === false);

  // ---- B. base32 + TOTP (RFC 6238 known-answer vectors, SHA-1, 6 digits) ----
  check("B base32 round-trips", base32Decode(base32Encode(Buffer.from("hello world"))).toString() === "hello world");
  // secret = ASCII "12345678901234567890" => base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  const SEC = base32Encode(Buffer.from("12345678901234567890"));
  check("B secret base32 matches RFC", SEC === "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  check("B KAT t=59s -> 287082", generateTotp(SEC, { nowMs: 59_000 }) === "287082");
  check("B KAT t=1111111109 -> 081804", generateTotp(SEC, { nowMs: 1111111109_000 }) === "081804");
  check("B KAT t=1234567890 -> 005924", generateTotp(SEC, { nowMs: 1234567890_000 }) === "005924");
  check("B generateTotpSecret is 32 base32 chars", /^[A-Z2-7]{32}$/.test(generateTotpSecret()));
  check("B otpauthUrl shape", otpauthUrl(SEC, { issuer: "AVC Studio", account: "a@b.co" }).startsWith("otpauth://totp/AVC%20Studio:a%40b.co?secret="));
  // verify: correct code returns the matched timestep; wrong code mismatches
  const vr = verifyTotp(SEC, "287082", { nowMs: 59_000 });
  check("B verify correct + timestep", vr.ok === true && vr.timestep === 1);
  check("B verify wrong -> mismatch", verifyTotp(SEC, "000000", { nowMs: 59_000 }).code === "TOTP_MISMATCH");
  check("B verify non-6-digit rejected", verifyTotp(SEC, "12ab", { nowMs: 59_000 }).code === "TOTP_CODE_INVALID");
  // skew window: a code from the previous timestep still verifies within window=1
  const prevCode = generateTotp(SEC, { nowMs: 59_000 - 30_000 });
  check("B skew window accepts prev step", verifyTotp(SEC, prevCode, { nowMs: 59_000, window: 1 }).ok === true);
  check("B window=0 rejects prev step", verifyTotp(SEC, prevCode, { nowMs: 59_000, window: 0 }).ok === false);
  // replay guard: a code whose timestep was already used is rejected
  check("B replay guard rejects used timestep", verifyTotp(SEC, "287082", { nowMs: 59_000, lastUsedTimestep: 1 }).code === "TOTP_REPLAY");
  check("B replay guard allows newer timestep", verifyTotp(SEC, "287082", { nowMs: 59_000, lastUsedTimestep: 0 }).ok === true);

  // ---- C. recovery codes ----
  const rc = generateRecoveryCodes(10);
  check("C generates 10 codes", rc.plaintext.length === 10 && rc.hashes.length === 10);
  check("C codes are distinct", new Set(rc.hashes).size === 10);
  check("C code display format", /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/.test(rc.plaintext[0]));
  check("C normalize variants match", hashRecoveryCode(rc.plaintext[0]) === hashRecoveryCode(rc.plaintext[0].toLowerCase().replace("-", " ")));
  check("C hash is sha256 hex", /^[0-9a-f]{64}$/.test(rc.hashes[0]));
  check("C match finds the right hash", matchRecoveryHash(rc.plaintext[3], rc.hashes) === rc.hashes[3]);
  check("C match miss -> null", matchRecoveryHash("ZZZZZ-ZZZZZ", rc.hashes) === null);
  check("C normalize strips separators", normalizeRecoveryCode("a3f9k-qm7xz") === "A3F9KQM7XZ");

  // The generator used to reduce a random BYTE with `% ALPHABET.length`. 256 = 8*31 + 8, so the first eight
  // characters came up 9 times in 256 against 8 for the rest. Proving that by sampling would be a flaky
  // distribution test, so the invariant is asserted deterministically instead: the index source is injected,
  // and an index outside the alphabet must be REFUSED rather than folded. Reintroducing a modulo makes the
  // refusal disappear and these two assertions fail.
  let seq = 0;
  const fixed = (values) => { seq = 0; return () => values[seq++ % values.length]; };
  check("C code maps index to alphabet position exactly",
    generateRecoveryCode({ randomIndex: fixed([0]) }) === "22222-22222");
  check("C code reaches the last alphabet character",
    generateRecoveryCode({ randomIndex: fixed([ALPHABET.length - 1]) }) === "ZZZZZ-ZZZZZ");
  check("C every alphabet index is reachable and in order",
    generateRecoveryCode({ randomIndex: fixed([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) }) === `${ALPHABET.slice(0, 5)}-${ALPHABET.slice(5, 10)}`);
  throwsSync("C an out-of-range index is refused, not folded with a modulo",
    () => generateRecoveryCode({ randomIndex: fixed([ALPHABET.length]) }), "E_RECOVERY_CODE_INDEX_RANGE");
  throwsSync("C a raw byte value is refused (this is the old bug's input)",
    () => generateRecoveryCode({ randomIndex: fixed([200]) }), "E_RECOVERY_CODE_INDEX_RANGE");
  throwsSync("C a non-integer index is refused",
    () => generateRecoveryCode({ randomIndex: fixed([1.5]) }), "E_RECOVERY_CODE_INDEX_RANGE");
  check("C alphabet still excludes confusable characters",
    !/[01OIL]/.test(ALPHABET) && ALPHABET.length === 31);
  check("C entropy unchanged: 10 characters from a 31-symbol alphabet",
    generateRecoveryCode().replace("-", "").length === 10);

  // ---- D. tokens ----
  const tk = generateToken(32);
  check("D token url-safe base64 >=43 chars", /^[A-Za-z0-9_-]{43,}$/.test(tk));
  check("D two tokens differ", generateToken() !== generateToken());
  check("D hashToken deterministic sha256", hashToken("abc") === hashToken("abc") && /^[0-9a-f]{64}$/.test(hashToken("abc")));
  check("D tokenHashEquals true", tokenHashEquals(hashToken("x"), hashToken("x")) === true);
  check("D tokenHashEquals false", tokenHashEquals(hashToken("x"), hashToken("y")) === false);
  const iss = issueToken({ ttlMs: 3600_000, now: 1_000_000 });
  check("D issueToken shape + expiry", iss.tokenHash === hashToken(iss.token) && iss.expiresAt.getTime() === 1_000_000 + 3600_000);

  // ---- E. secret box (AES-256-GCM) ----
  const key = generateSecretBoxKey();
  const box = encryptSecret(SEC, key);
  check("E versioned box format", /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(box));
  check("E decrypt round-trip", decryptSecret(box, key) === SEC);
  check("E two encryptions differ (iv)", encryptSecret(SEC, key) !== encryptSecret(SEC, key));
  throwsSync("E wrong key throws", () => decryptSecret(box, generateSecretBoxKey()));
  throwsSync("E tampered ct throws", () => decryptSecret(box.slice(0, -2) + (box.slice(-2) === "aa" ? "bb" : "aa"), key));
  throwsSync("E malformed throws", () => decryptSecret("nope", key), "SECRET_BOX_MALFORMED");
  throwsSync("E bad key length throws", () => encryptSecret("x", Buffer.alloc(16)), "SECRET_BOX_KEY_INVALID");

  console.log(`Step 5C.21 auth crypto: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.log("FATAL", e); process.exit(1); });
