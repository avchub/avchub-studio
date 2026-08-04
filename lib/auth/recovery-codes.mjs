// P0 Step 5C.21 — MFA recovery codes. High-entropy single-use codes, shown ONCE at generation, stored
// only as sha256 hashes. Regenerating mints a new batch and revokes the old one. Using one is a security
// event (recorded by the service). This module is pure: it mints + normalizes + hashes; the DB layer owns
// batch/used/revoked state.

import { randomInt, createHash, timingSafeEqual } from "node:crypto";

export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // Crockford-ish: no 0/O/1/I/L confusables
const GROUPS = 2, GROUP_LEN = 5; // e.g. "A3F9K-QM7XZ" (10 chars, ~50 bits)

// A uniform index into ALPHABET.
//
// This used to be `randomBytes(n)[i] % ALPHABET.length`, which is biased: a byte is uniform over 256
// values and 256 = 8 x 31 + 8, so the first EIGHT characters of the alphabet came up 9 times in 256
// while the other 23 came up 8 — about 12.5% more often. The loss is small in absolute terms (~4.9523
// bits per character against an ideal 4.9542, so ~0.02 bits of a ~49.5-bit code) but it is a real
// bias in an MFA credential, and it costs nothing to remove. crypto.randomInt does the rejection
// sampling internally: it discards the values that would fold unevenly instead of folding them.
function uniformIndex() {
  return randomInt(ALPHABET.length);
}

// `randomIndex` is injectable so the invariants below can be proven deterministically rather than by
// sampling a distribution, which would be a flaky test. Production always uses uniformIndex.
export function generateRecoveryCode({ randomIndex = uniformIndex } = {}) {
  let s = "";
  for (let i = 0; i < GROUPS * GROUP_LEN; i += 1) {
    if (i > 0 && i % GROUP_LEN === 0) s += "-";
    const index = randomIndex();
    // Refusing an out-of-range index is what keeps the bias from creeping back: the tempting "fix" for
    // a value of 200 is `% ALPHABET.length`, and that single character is exactly the defect this
    // function was rewritten to remove. An index outside the alphabet is a programming error, so it
    // fails loudly instead of being folded into a slightly-more-likely character.
    if (!Number.isInteger(index) || index < 0 || index >= ALPHABET.length) {
      throw Object.assign(
        new Error(`recovery code index ${index} is outside 0..${ALPHABET.length - 1}`),
        { code: "E_RECOVERY_CODE_INDEX_RANGE" }
      );
    }
    s += ALPHABET[index];
  }
  return s;
}

// Normalize for hashing/compare: uppercase, strip everything but the alphabet (so "a3f9k-qm7xz",
// "A3F9KQM7XZ", "A3F9K QM7XZ" all match). Display keeps the hyphen; storage keys off the normal form.
export function normalizeRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(new RegExp(`[^${ALPHABET}]`, "g"), "");
}

export function hashRecoveryCode(code) {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

// Generate a fresh batch. Returns { plaintext: string[] (show ONCE), hashes: string[] }.
export function generateRecoveryCodes(count = 10, { randomIndex } = {}) {
  const n = Math.max(1, Math.min(20, Number(count) || 10));
  const plaintext = [], hashes = [], seen = new Set();
  while (plaintext.length < n) {
    const c = generateRecoveryCode(randomIndex ? { randomIndex } : undefined);
    const h = hashRecoveryCode(c);
    if (seen.has(h)) continue;
    seen.add(h); plaintext.push(c); hashes.push(h);
  }
  return { plaintext, hashes };
}

// Constant-time membership check of a submitted code against a set of stored hashes.
export function matchRecoveryHash(code, storedHashes) {
  const h = Buffer.from(hashRecoveryCode(code), "hex");
  let matchedHex = null;
  for (const stored of storedHashes || []) {
    const s = Buffer.from(String(stored), "hex");
    if (s.length === h.length && timingSafeEqual(s, h)) matchedHex = String(stored);
  }
  return matchedHex; // the matched stored hash (so the caller marks THAT row used), or null
}
