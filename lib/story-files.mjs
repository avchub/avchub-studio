// Story file + index.csv contract.
//
// index.csv is the pipeline's join table. Constraints that MUST hold:
// - The WPF viewer parses it positionally and line-by-line, so the first
//   seven columns stay exactly: file,seed,variant,language,words,provider,
//   model — new columns are appended AFTER, and no cell may contain a
//   newline.
// - It must ACCUMULATE across runs (the old code overwrote it wholesale,
//   which made the static site forget every previous batch).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { parseCsv, toCsv, singleLineCell } from "./csv.mjs";
import { resolveFromRoot } from "./paths.mjs";
import { stripMetadata, parseMetadata, makeTitle, makeExcerpt } from "./text.mjs";
import { slugFromStoryFile } from "./slug.mjs";

export const INDEX_COLUMNS = [
  "file", "seed", "variant", "language", "words",
  "provider", "model", "slug", "title", "excerpt"
];

// Metadata header written at the top of each story .md. Values are kept to a
// single line and cannot break out of the HTML comment.
export function buildMetadataBlock(fields) {
  const lines = ["<!--"];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${sanitizeMetaValue(value)}`);
  }
  lines.push("-->", "", "");
  return lines.join("\n");
}

// The block above is a real HTML comment in a Markdown file that gets rendered to a static site, so a value
// that can terminate the comment escapes into the page as live markup.
//
// Replacing "-->" alone was not enough: HTML also ends a comment at "--!>" (the spec's comment-end-bang
// state), and browsers accept it. Rather than chase terminator spellings, neutralise the "--" digraph that
// every one of them is built from — which is also what the HTML spec says a comment may not contain in the
// first place. "-->" and "--!>" both become harmless, and so does any future spelling.
function sanitizeMetaValue(value) {
  return String(value ?? "")
    .replace(/--+/g, (run) => "- ".repeat(run.length - 1) + "-")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

// Load index.csv into records keyed by INDEX_COLUMNS. Accepts the historical
// 6-column (…,model) and 7-column (…,provider,model) formats as well as the
// current 10-column one; missing fields become "".
export async function loadIndex(indexFile) {
  if (!existsSync(indexFile)) return [];
  const rows = parseCsv(await readFile(indexFile, "utf8"));
  if (rows.length <= 1) return [];

  const entries = [];
  for (const row of rows.slice(1)) {
    if (!row[0] || row[0] === "file") continue;
    const entry = {
      file: row[0] ?? "",
      seed: row[1] ?? "",
      variant: row[2] ?? "",
      language: row[3] ?? "",
      words: row[4] ?? "",
      provider: "",
      model: "",
      slug: "",
      title: "",
      excerpt: ""
    };
    if (row.length >= 7) {
      entry.provider = row[5] ?? "";
      entry.model = row[6] ?? "";
      entry.slug = row[7] ?? "";
      entry.title = row[8] ?? "";
      entry.excerpt = row[9] ?? "";
    } else {
      entry.model = row[5] ?? "";
    }
    entries.push(entry);
  }
  return entries;
}

// Insert or replace by normalized file path so re-running a batch updates
// rows instead of duplicating them.
export function upsertIndexEntry(entries, entry) {
  const key = normalizeFileKey(entry.file);
  const index = entries.findIndex((existing) => normalizeFileKey(existing.file) === key);
  if (index === -1) {
    entries.push(entry);
  } else {
    entries[index] = entry;
  }
  return entries;
}

export async function saveIndex(indexFile, entries) {
  const rows = [INDEX_COLUMNS];
  for (const entry of entries) {
    rows.push(INDEX_COLUMNS.map((column) => singleLineCell(entry[column] ?? "")));
  }
  await writeFile(indexFile, toCsv(rows), "utf8");
}

function normalizeFileKey(filePath) {
  return String(filePath ?? "").replaceAll("\\", "/").toLowerCase();
}

// Read the story file behind an index entry and resolve title/excerpt/slug
// with one precedence everywhere: index column -> frontmatter -> derived from
// body. This is what keeps titles IDENTICAL across the site, the Facebook
// CSV, the WordPress manifest and the image-prompt CSV (they used to be
// re-guessed with different truncation limits in each script).
export async function hydrateStoryEntry(entry) {
  const sourcePath = resolveFromRoot(entry.file);
  const markdown = await readFile(sourcePath, "utf8");
  const metadata = parseMetadata(markdown);
  const body = stripMetadata(markdown).trim();

  return {
    ...entry,
    sourcePath,
    metadata,
    body,
    language: entry.language || metadata.language || "",
    title: entry.title || metadata.title || makeTitle(body, entry.seed),
    excerpt: entry.excerpt || metadata.excerpt || makeExcerpt(body),
    slug: entry.slug || slugFromStoryFile(entry.file)
  };
}
