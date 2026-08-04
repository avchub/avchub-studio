// Escaping for values embedded in an FFmpeg filtergraph.
//
// This is NOT shell escaping. Every caller spawns ffmpeg with an argv array and no shell, so the shell
// never sees these strings. What does see them is ffmpeg's own filtergraph parser, which has its own
// grammar, and getting that grammar wrong does not produce an error — it produces a filter that runs and
// quietly does the wrong thing:
//
//   - options inside one filter are separated by ':', so an unescaped drive letter turns
//     fontfile='C:/Windows/Fonts/arial.ttf' into fontfile='C' plus junk options. ffmpeg draws the box and
//     omits the text, exits 0, and the frame looks fine until you notice it is unlabelled.
//   - '\' is the escape character, so a value carrying a literal backslash consumes the character after it.
//   - a value is wrapped in '...' by the caller, so a literal quote inside it ends the quoted section
//     early and the remainder is reparsed as filter options.
//
// The order below matters and is the whole point: backslash is dealt with FIRST, because every later
// rule introduces backslashes of its own and a second pass over them would double-escape the escapes.

// Characters that carry meaning inside a single-quoted filter option value, in the order they must be
// handled. Backslash first, always.
const QUOTE = /'/g;
const COLON = /:/g;
const BACKSLASH = /\\/g;

/**
 * Escape a filesystem path for use inside a single-quoted filtergraph option (fontfile=, subtitles=, …).
 *
 * `windowsSeparators` decides how a backslash is read, and the distinction is not cosmetic:
 *   - on Windows a backslash is only ever a path separator, and ffmpeg accepts forward slashes there, so
 *     rewriting them sidesteps the escaping question entirely — this is also what the subtitles filter has
 *     always needed, since a Windows path reaches libass through a second layer of parsing.
 *   - on POSIX a backslash is a legal character in a filename. Rewriting it would name a DIFFERENT file,
 *     so it has to be escaped instead. Silently opening the wrong path is worse than an ugly string.
 *
 * It is a parameter rather than a direct `process.platform` read so both branches are testable on either
 * platform; production callers use the default.
 */
export function escapeFilterPath(value, { windowsSeparators = process.platform === "win32" } = {}) {
  const raw = String(value ?? "");
  const backslashHandled = windowsSeparators
    ? raw.replace(BACKSLASH, "/")
    : raw.replace(BACKSLASH, "\\\\");
  return backslashHandled.replace(QUOTE, "\\'").replace(COLON, "\\:");
}

/**
 * Escape a literal text value for use inside a single-quoted filtergraph option (drawtext text=, …).
 *
 * Same grammar as above minus the path question: a backslash here is data, never a separator, so it is
 * always escaped and never rewritten.
 *
 * Note this does NOT neutralise '%'. drawtext expands % sequences only when expansion is enabled; callers
 * that pass arbitrary text must set `expansion=none`, which is a filter option rather than an escaping
 * concern and cannot be expressed here.
 */
export function escapeFilterText(value) {
  return String(value ?? "")
    .replace(BACKSLASH, "\\\\")
    .replace(QUOTE, "\\'")
    .replace(COLON, "\\:");
}
