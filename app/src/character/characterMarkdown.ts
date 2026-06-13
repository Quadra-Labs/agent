// characterMarkdown.ts — parse a Markdown character file (YAML frontmatter + body) into
// the raw record parseCharacter validates. Frontmatter = name + optional bio +
// templateCategoryIds; the body below the closing `---` becomes the systemPrompt. A
// DELIBERATELY TINY YAML subset (scalars + simple string lists) so no yaml dependency is
// needed; out-of-subset input is a typed error. Transforms text only — character.ts
// owns validation, so Markdown and JSON share one validator.

// Result of splitting + parsing the markdown. `body` is the post-frontmatter prose
// (the systemPrompt source); `frontmatter` is the parsed key->value map. A structural
// problem (missing fences, malformed list) yields { ok: false } with a reason.
export type MarkdownParseResult =
  | { ok: true; record: Record<string, unknown> }
  | { ok: false; message: string };

// Split a `key: value` line at the FIRST colon only, so values containing ':' (URLs,
// prose) survive. Returns undefined for a line with no colon (not a key line).
function splitKeyValue(line: string): { key: string; value: string } | undefined {
  const idx = line.indexOf(":");
  if (idx < 0) return undefined;
  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

// Strip one layer of matching surrounding quotes from a scalar, if present. Keeps
// authoring forgiving (quoted or bare both work) without a full YAML string grammar.
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Parse an inline flow list `[a, b, c]` into trimmed, unquoted, non-empty items.
function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1); // drop the surrounding [ ]
  if (inner.trim().length === 0) return [];
  return inner
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter((item) => item.length > 0);
}

/**
 * Parse the frontmatter region (the lines BETWEEN the `---` fences) into a record.
 * Supports exactly: `key: scalar`, `key: [a, b]` inline lists, and block lists
 * written as a bare `key:` followed by `  - item` lines. Pure. Returns a typed
 * failure for a malformed block (e.g. a `- item` with no preceding key).
 */
export function parseFrontmatter(lines: readonly string[]): MarkdownParseResult {
  const record: Record<string, unknown> = {};
  let currentListKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, ""); // trailing-trim; keep leading for indent
    if (line.trim().length === 0) continue; // blank lines are ignored
    if (line.trimStart().startsWith("#")) continue; // YAML comment

    const trimmed = line.trim();

    // A block-list item belongs to the most recent bare `key:`.
    if (trimmed.startsWith("- ") || trimmed === "-") {
      if (currentListKey === undefined) {
        return { ok: false, message: `list item "${trimmed}" has no preceding key in frontmatter` };
      }
      const item = unquote(trimmed.replace(/^-\s*/, "").trim());
      if (item.length > 0) {
        (record[currentListKey] as string[]).push(item);
      }
      continue;
    }

    const kv = splitKeyValue(line);
    if (kv === undefined) {
      return { ok: false, message: `unrecognized frontmatter line: "${trimmed}"` };
    }
    const { key, value } = kv;
    if (key.length === 0) {
      return { ok: false, message: `empty key in frontmatter line: "${trimmed}"` };
    }

    if (value.length === 0) {
      // Bare `key:` -> opens a block list; subsequent `- item` lines append to it.
      record[key] = [];
      currentListKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      record[key] = parseInlineList(value);
      currentListKey = undefined;
    } else {
      record[key] = unquote(value);
      currentListKey = undefined;
    }
  }

  return { ok: true, record };
}

/**
 * Parse a full Markdown character document into the raw record parseCharacter
 * validates. Requires opening `---` as the first non-empty line and a closing `---`;
 * everything after the closing fence becomes `systemPrompt` (trimmed) UNLESS the
 * frontmatter already set systemPrompt explicitly. Pure (no I/O). Returns a typed
 * failure for missing/!unterminated frontmatter so the loader can report it cleanly.
 */
export function parseMarkdownCharacter(text: string): MarkdownParseResult {
  const allLines = text.split(/\r?\n/);

  // Find the opening fence (first non-empty line must be ---).
  let openIdx = -1;
  for (let i = 0; i < allLines.length; i += 1) {
    if (allLines[i].trim().length === 0) continue;
    openIdx = allLines[i].trim() === "---" ? i : -1;
    break;
  }
  if (openIdx === -1) {
    return {
      ok: false,
      message: 'markdown character must begin with a "---" YAML frontmatter fence',
    };
  }

  // Find the closing fence.
  let closeIdx = -1;
  for (let i = openIdx + 1; i < allLines.length; i += 1) {
    if (allLines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return { ok: false, message: 'markdown frontmatter is not closed with a "---" fence' };
  }

  const fmLines = allLines.slice(openIdx + 1, closeIdx);
  const parsed = parseFrontmatter(fmLines);
  if (!parsed.ok) return parsed;

  const body = allLines.slice(closeIdx + 1).join("\n").trim();
  const record = { ...parsed.record };

  // The body is the systemPrompt source, unless frontmatter already declared one.
  if (record.systemPrompt === undefined && body.length > 0) {
    record.systemPrompt = body;
  }

  return { ok: true, record };
}
