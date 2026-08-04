#!/usr/bin/env node
// Lightweight test harness for the pipeline libs. Run: node tests/run-tests.mjs
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { repoRoot, fromRoot, resolveFromRoot, isAbsolutePath, toRecordPath } from "../lib/paths.mjs";
import { parseArgs, numberOption, positiveIntOption } from "../lib/cli.mjs";
import {
  stripBom, stripMetadata, parseMetadata, makeTitle, makeExcerpt,
  truncateAtWord, countWords, escapeHtml, languageToHtmlLang,
  mixedScriptWords, usesCyrillicScript
} from "../lib/text.mjs";
import { safeSlug, slugFromStoryFile, transliterate } from "../lib/slug.mjs";
import { parseCsv, parseCsvObjects, toCsv, singleLineCell } from "../lib/csv.mjs";
import { extractSeedArray, repairUnescapedQuotes } from "../lib/json-extract.mjs";
import { buildMetadataBlock, loadIndex, upsertIndexEntry, saveIndex, INDEX_COLUMNS } from "../lib/story-files.mjs";
import { DEFAULTS, applyPresets, normalizeStorySettings, validateStorySettings } from "../lib/config.mjs";
import {
  normalizeProvider, defaultModelForProvider, normalizeClaudeCredential,
  providerMaxTokensCap, isDefaultAnthropicBaseUrl
} from "../lib/llm.mjs";
import { escapeFilterPath, escapeFilterText } from "../lib/media/ffmpeg-filter.mjs";
import { ffmpegRunnable } from "../lib/media/ffmpeg-locator.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";

let failures = 0;
let passed = 0;

function check(name, actual, expected = true) {
  const ok = typeof expected === "boolean" ? Boolean(actual) === expected : actual === expected;
  if (ok) {
    passed += 1;
  } else {
    failures += 1;
    console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

function checkThrows(name, fn) {
  try {
    fn();
    failures += 1;
    console.error(`FAIL ${name} (expected throw)`);
  } catch {
    passed += 1;
  }
}

// ---------- paths ----------
check("repoRoot is absolute", path.isAbsolute(repoRoot));
check("fromRoot joins", fromRoot("output").endsWith("output"));
// Absoluteness must be decided by BOTH platforms' rules, not by whichever one this process happens to be
// running on. These ran green on Windows and red on Linux until resolveFromRoot stopped delegating to the
// platform-default path.isAbsolute — a Windows path joined onto the repo root becomes a path that exists
// nowhere, and nothing downstream notices until a file is missing.
check("resolveFromRoot keeps absolute", resolveFromRoot("C:\\x\\y.txt"), "C:\\x\\y.txt");
check("resolveFromRoot keeps a windows drive path with forward slashes", resolveFromRoot("C:/x/y.txt"), "C:/x/y.txt");
check("resolveFromRoot keeps a lowercase drive letter", resolveFromRoot("d:\\media\\clip.mp4"), "d:\\media\\clip.mp4");
check("resolveFromRoot keeps a UNC share", resolveFromRoot("\\\\server\\share\\clip.mp4"), "\\\\server\\share\\clip.mp4");
check("resolveFromRoot keeps a posix absolute", resolveFromRoot("/var/media/clip.mp4"), "/var/media/clip.mp4");
// Relative behaviour must not change. A drive-RELATIVE path (no separator after the colon) is not absolute
// on Windows either, so it still resolves against the root.
check("resolveFromRoot joins a relative path", resolveFromRoot("output/a.md"), path.join(repoRoot, "output/a.md"));
check("resolveFromRoot joins a drive-relative path", resolveFromRoot("C:x.txt"), path.join(repoRoot, "C:x.txt"));
check("resolveFromRoot empty gives the root", resolveFromRoot("   "), repoRoot);
check("isAbsolutePath agrees on both rule sets",
  [isAbsolutePath("C:\\x"), isAbsolutePath("/x"), isAbsolutePath("\\\\s\\h"), isAbsolutePath("x"), isAbsolutePath("C:x")].join(","),
  "true,true,true,false,false");
check("toRecordPath posix-relative", toRecordPath(fromRoot("output", "a.md")), "output/a.md");

// ---------- cli ----------
{
  const args = parseArgs(["--config", "c.json", "--dry-run", "--count=5"]);
  check("cli --flag value", args.config, "c.json");
  check("cli bare flag", args["dry-run"], true);
  check("cli --key=value", args.count, "5");
  checkThrows("cli unknown flag rejected", () => parseArgs(["--nope"], ["config"]));
  checkThrows("cli positional rejected", () => parseArgs(["stray"]));
  check("numberOption keeps 0", numberOption(0, 3), 0);
  check("numberOption fallback", numberOption(undefined, 3), 3);
  check("positiveIntOption rejects 0", positiveIntOption(0, 7), 7);
}

// ---------- text ----------
{
  const BOM = String.fromCharCode(0xfeff);
  check("stripBom", stripBom(`${BOM}x`), "x");

  const body = [
    "„Защо ми го скри?“ Захласнах думите като изстрел, а гласът ми проби тишината в кабинета му.",
    "",
    "Втори параграф."
  ].join("\n");
  const title = makeTitle(body);
  check("title stops at first sentence (quote-aware)", title, "Защо ми го скри?");

  check("title strips U+201E quote", makeTitle("„Тест.“ Друго изречение."), "Тест.");
  check("makeExcerpt keeps short body intact", makeExcerpt("Hello world."), "Hello world.");
  const long = "дума ".repeat(100).trim();
  const excerpt = makeExcerpt(long);
  check("makeExcerpt truncates with ellipsis", excerpt.endsWith("…"));
  check("makeExcerpt within limit", excerpt.length <= 211);
  check("truncateAtWord no-op when short", truncateAtWord("abc", 10), "abc");
  check("countWords", countWords(" one two  three "), 3);
  check("escapeHtml", escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  check("languageToHtmlLang bg", languageToHtmlLang("Bulgarian"), "bg");
  check("languageToHtmlLang unknown", languageToHtmlLang("Klingon"), "en");

  const md = "<!--\ntitle: Test T\nseed: abc\n-->\n\nBody here.";
  check("parseMetadata title", parseMetadata(md).title, "Test T");
  check("stripMetadata", stripMetadata(md), "Body here.");
}

// ---------- mixed-script quality gate ----------
{
  const glitched = mixedScriptWords("мътната светлина на декемврийското слunce и свръхсъ naturalни обяснения");
  check("mixedScript detects glitched words", glitched.length, 2);
  check("mixedScript names the words", glitched.join(","), "слunce,naturalни");
  check("mixedScript clean cyrillic", mixedScriptWords("напълно чист български текст").length, 0);
  check("mixedScript clean english", mixedScriptWords("perfectly clean english text").length, 0);
  check("mixedScript quoted word", mixedScriptWords("каза „слunce“ тихо").length, 1);
  check("usesCyrillicScript bulgarian", usesCyrillicScript("Bulgarian"), true);
  check("usesCyrillicScript english", usesCyrillicScript("English"), false);
  check("usesCyrillicScript swedish", usesCyrillicScript("Swedish"), false);
}

// ---------- slug ----------
{
  check("transliterate bg", transliterate("тайна"), "tayna");
  check("safeSlug bulgarian", safeSlug("Голямата тайна на старите карти"), "golyamata-tayna-na-starite-karti");
  check("safeSlug vietnamese", safeSlug("Bí mật gia đình của mẹ"), "bi-mat-gia-dinh-cua-me");
  check("safeSlug never empty", safeSlug("!!!"), "story");
  const winPath = ["output", "001-locked-drawer-photo-v1.md"].join("\\");
  check("slugFromStoryFile windows path", slugFromStoryFile(winPath), "locked-drawer-photo-v1");
  check("slugFromStoryFile posix path", slugFromStoryFile("output/010-x-y-v2.md"), "x-y-v2");
}

// ---------- csv ----------
{
  const rows = [["a", "b"], ['has "quote"', "line1\nline2"], ["comma, here", "plain"]];
  const roundtrip = parseCsv(toCsv(rows));
  check("csv roundtrip quotes/newlines/commas", JSON.stringify(roundtrip), JSON.stringify(rows));

  const guarded = toCsv([["=SUM(A1)", "-note", "42", "-7"]], { guardFormulas: true });
  check("csv formula guard =", guarded.includes("'=SUM(A1)"));
  check("csv formula guard -text", guarded.includes("'-note"));
  check("csv formula guard keeps numbers", guarded.includes("42") && guarded.includes(",-7"));

  const { header, records } = parseCsvObjects("a,b\n1,2\n3,4\n");
  check("csv objects header", header.join("|"), "a|b");
  check("csv objects record", records[1].b, "4");
  check("singleLineCell", singleLineCell("x\r\ny"), "x y");
}

// ---------- json-extract ----------
{
  check("extract plain array", extractSeedArray('[{"slug":"a"}]').length, 1);
  check("extract seeds wrapper", extractSeedArray('{"seeds":[{"slug":"a"},{"slug":"b"}]}').length, 2);
  check("extract fenced with prefix", extractSeedArray('Here is the JSON:\n```json\n[{"slug":"a"}]\n```').length, 1);
  check("extract with trailing prose", extractSeedArray('[{"slug":"a"}] hope this helps!').length, 1);

  // THE regression: real broken response that aborted a production run.
  const fixture = await readFile(new URL("./fixtures/broken-seed-response.txt", import.meta.url), "utf8");
  let recovered = null;
  try {
    recovered = extractSeedArray(fixture);
  } catch {
    recovered = null;
  }
  check("extract recovers real broken production response", Array.isArray(recovered) && recovered.length === 2);
  if (recovered) {
    check("recovered seed slug intact", recovered[0].slug, "babina-tochna-kyrsha");
    check("recovered premise keeps interior quote text", recovered[0].premise.includes("помага"));
  }

  const repaired = repairUnescapedQuotes('{"a": "x „y" z"}');
  check("repairUnescapedQuotes parses", JSON.parse(repaired).a.includes("z"));
}

// ---------- ffmpeg filtergraph escaping ----------
// These strings are never seen by a shell — every caller spawns ffmpeg with an argv array. What parses them
// is ffmpeg's filtergraph grammar, where ':' separates options, '\' escapes, and the value sits inside
// '...'. Getting it wrong does not fail; it silently drops the option, which is why these are asserted
// character by character rather than by running ffmpeg.
{
  // A Windows font path: the drive-letter colon is what truncated fontfile='C:/...' to 'C'.
  check("filter path escapes a windows drive colon",
    escapeFilterPath("C:/Windows/Fonts/arial.ttf", { windowsSeparators: true }),
    "C\\:/Windows/Fonts/arial.ttf");
  // Backslash separators are rewritten on Windows, where a backslash can only ever be a separator.
  check("filter path rewrites windows separators",
    escapeFilterPath("C:\\Windows\\Fonts\\arial.ttf", { windowsSeparators: true }),
    "C\\:/Windows/Fonts/arial.ttf");
  // On POSIX a backslash is a legal filename character, so it must be ESCAPED, never rewritten —
  // rewriting it would silently name a different file.
  check("filter path escapes a posix backslash instead of rewriting it",
    escapeFilterPath("/media/od\\d name/clip.srt", { windowsSeparators: false }),
    "/media/od\\\\d name/clip.srt");
  check("filter path leaves a plain posix path alone",
    escapeFilterPath("/var/media/clip.srt", { windowsSeparators: false }),
    "/var/media/clip.srt");
  // A quote would close the '...' section early and the rest of the path would be read as filter options.
  check("filter path escapes a quote",
    escapeFilterPath("/media/it's here/clip.srt", { windowsSeparators: false }),
    "/media/it\\'s here/clip.srt");
  check("filter path keeps spaces verbatim",
    escapeFilterPath("/media/My Films/final cut.srt", { windowsSeparators: false }),
    "/media/My Films/final cut.srt");
  // Ordering regression: backslash must be handled BEFORE the escapes that introduce backslashes,
  // otherwise the escape characters get escaped again and the value is corrupted.
  check("filter path does not double-escape its own escapes",
    escapeFilterPath("a\\b:c", { windowsSeparators: false }),
    "a\\\\b\\:c");
  check("filter text escapes backslash, quote and colon",
    escapeFilterText("2.40s : it's \\ here"),
    "2.40s \\: it\\'s \\\\ here");
  check("filter text on plain label is unchanged", escapeFilterText("6.00s  (50 pct)"), "6.00s  (50 pct)");
  check("filter escaping is total on empty input", `${escapeFilterPath(null)}|${escapeFilterText(undefined)}`, "|");
}

// ---------- ffmpeg availability probe ----------
// Six suites and the ops health snapshot decided "is FFmpeg here?" with `existsSync(binary)`. The locator's
// usual answer is the bare command name "ffmpeg", left for PATH to resolve, and existsSync("ffmpeg") asks
// whether a file of that name sits in the CURRENT DIRECTORY. So every one of them reported "no ffmpeg" on a
// perfectly good PATH installation — including CI, which installs FFmpeg precisely so those suites run.
{
  // "node" is a bare command name resolved through PATH and is guaranteed present — this process is it.
  // That is the exact shape that broke: on PATH, but not a file in the working directory. probeArgs is
  // overridden only because node spells the flag --version; the resolution path under test is the same.
  check("runnable finds a PATH command that is not a file here",
    ffmpegRunnable("node", { probeArgs: ["--version"] }), true);
  check("the old existsSync test would have called that missing", existsSync("node"), false);
  // And the probe must actually gate on the exit status, not merely on the command being spawnable.
  check("runnable rejects a PATH command whose probe fails",
    ffmpegRunnable("node", { probeArgs: ["--this-flag-does-not-exist"] }), false);

  check("runnable rejects a command that does not exist", ffmpegRunnable("definitely-not-a-real-binary-xyz"), false);
  check("runnable rejects an absolute path to nothing",
    ffmpegRunnable(path.join(repoRoot, "no", "such", "ffmpeg.exe")), false);
  check("runnable rejects empty input", [ffmpegRunnable(""), ffmpegRunnable(null), ffmpegRunnable(undefined)].join(","), "false,false,false");
  // A real file that is not an executable must not count as runnable.
  check("runnable rejects a non-executable file", ffmpegRunnable(path.join(repoRoot, "package.json")), false);
}

// ---------- story-files ----------
{
  const block = buildMetadataBlock({ title: "A --> B", seed: "s1\nx" });
  check("metadata escapes arrow", !block.slice(4, block.lastIndexOf("-->")).includes("-->"));
  check("metadata single line", block.includes("seed: s1 x"));

  // The block is a real HTML comment rendered by the static site, and HTML ends a comment at "--!>" as
  // well as at "-->". Neutralising the "--" digraph covers both, and any other spelling built from it.
  const bang = buildMetadataBlock({ title: "A --!> B" });
  check("metadata neutralises the comment-end-bang form", !bang.slice(4, bang.lastIndexOf("-->")).includes("--!>"));
  check("metadata leaves no -- digraph in the body at all",
    !buildMetadataBlock({ title: "em--dash --- and ----" }).slice(4, -6).includes("--"));
  check("metadata keeps a single hyphen", buildMetadataBlock({ title: "well-known" }).includes("well-known"));

  const dir = await mkdtemp(path.join(os.tmpdir(), "sf-"));
  const indexFile = path.join(dir, "index.csv");

  // Old 7-column format is readable.
  const oldCsv = "file,seed,variant,language,words,provider,model\noutput\\001-a-v1.md,a,1,Bulgarian,2000,openai,gpt-4.1-mini\n";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(indexFile, oldCsv, "utf8");
  const entries = await loadIndex(indexFile);
  check("loadIndex old format", entries.length === 1 && entries[0].model === "gpt-4.1-mini" && entries[0].title === "");

  // Upsert replaces same file (even with different slashes) and accumulates new ones.
  upsertIndexEntry(entries, {
    file: "output/001-a-v1.md", seed: "a", variant: "1", language: "Bulgarian", words: "2100",
    provider: "anthropic", model: "m", slug: "a-v1", title: "T", excerpt: "E"
  });
  upsertIndexEntry(entries, {
    file: "output/002-b-v1.md", seed: "b", variant: "1", language: "Bulgarian", words: "1900",
    provider: "anthropic", model: "m", slug: "b-v1", title: "T2", excerpt: "E2"
  });
  check("upsert replaced + appended", entries.length, 2);
  await saveIndex(indexFile, entries);
  const reloaded = await loadIndex(indexFile);
  check("saveIndex/loadIndex roundtrip", reloaded.length === 2 && reloaded[0].words === "2100" && reloaded[1].title === "T2");
  check("index columns stable prefix", INDEX_COLUMNS.slice(0, 7).join(","), "file,seed,variant,language,words,provider,model");
  await rm(dir, { recursive: true, force: true });
}

// ---------- config ----------
{
  const settings = normalizeStorySettings({ minWords: 0, retries: 0 }, {});
  check("settings keep explicit 0 retries", settings.retries, 0);
  check("settings minWords 0 kept", settings.minWords, 0);
  check("settings default concurrency", settings.concurrency, DEFAULTS.concurrency);

  const bad = validateStorySettings({ ...settings, minWords: 3000, maxWords: 2000 });
  check("validate flags min>max", bad.errors.length >= 1);

  const merged = await applyPresets({ countryPreset: "bulgaria", genrePreset: "family_secrets" });
  check("preset resolves language", merged.language, "Bulgarian");
  check("preset resolves minWords", merged.minWords, 1900);
  check("preset resolves theme", String(merged.seedGeneration?.theme || "").includes("Family secrets"));
  const overridden = await applyPresets({ countryPreset: "bulgaria", language: "English" });
  check("explicit config wins over preset", overridden.language, "English");
}

// ---------- llm pure helpers ----------
{
  check("provider openai aliases", normalizeProvider("ChatGPT"), "openai");
  check("provider claude aliases", normalizeProvider("claude"), "anthropic");
  checkThrows("provider unknown throws", () => normalizeProvider("grok"));
  check("default model openai", typeof defaultModelForProvider("openai"), "string");
  check("claude credential from url", normalizeClaudeCredential("https://x?key=abc123"), "abc123");
  check("claude credential passthrough", normalizeClaudeCredential("sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx"), "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx"); // scan-secrets:allow fixture proving a passthrough, not a key
  check("declared cap applies to a non-default endpoint", providerMaxTokensCap({ provider: "anthropic", anthropicBaseUrl: "https://llm-proxy.example.com", env: { LLM_MAX_OUTPUT_TOKENS: "3000" } }), 3000);
  check("no declared cap means no cap", providerMaxTokensCap({ provider: "anthropic", anthropicBaseUrl: "https://llm-proxy.example.com", env: {} }), Infinity);
  check("the official endpoint is never capped", providerMaxTokensCap({ provider: "anthropic", anthropicBaseUrl: "https://api.anthropic.com", env: { LLM_MAX_OUTPUT_TOKENS: "3000" } }), Infinity);
  check("openai no cap", providerMaxTokensCap({ provider: "openai" }), Infinity);
  check("default base url check", isDefaultAnthropicBaseUrl("https://api.anthropic.com/"), true);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
