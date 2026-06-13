// character.ts — the user-authorable agent identity (name [= checkpoint index `agent`
// key], bio, optional systemPrompt, optional templateCategoryIds) + its loader. Built
// on a DEFAULT_CHARACTER so character-less code paths are byte-identical. Characters
// live under app/characters/ as Markdown (frontmatter + body) or JSON; both
// converge on parseCharacter and return a typed ok/kind result, never a blind throw.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute, extname, basename } from "node:path";

import { parseMarkdownCharacter } from "./characterMarkdown.js";

const here = dirname(fileURLToPath(import.meta.url));

// characters/ sits one level up from src/ (alongside .env, .eliza-db).
const CHARACTERS_DIR = resolve(here, "..", "characters");

/**
 * A user-authorable agent identity. `name` doubles as the checkpoint index `agent`
 * key, so resuming a prior session requires booting under the SAME name. All fields
 * except `name` and `bio` are optional; absent ones fall back to runtime/chat
 * defaults, keeping non-CLI callers unchanged.
 */
export interface AgentCharacter {
  /** Display name AND the checkpoint index `agent` key. Non-empty. */
  readonly name: string;
  /** One or more bio lines describing the agent. Non-empty array of non-empty strings. */
  readonly bio: readonly string[];
  /**
   * OPTIONAL system-prompt override for the chat loop. Absent -> chat.ts's built-in
   * SYSTEM_PROMPT is used (the original behavior). Lets a character change tone/role
   * without editing code.
   */
  readonly systemPrompt?: string;
  /**
   * OPTIONAL job-template category ids this agent offers (e.g. ["btc-price-guess"]).
   * Absent or empty -> the agent does plain chat with NO job-intake section. When
   * present, the CLI seeds + loads templates and injects ONLY the named ones into the
   * prompt. Ids that do not match a known template are ignored (with a warning).
   */
  readonly templateCategoryIds?: readonly string[];
}

// The default identity: the original hardcoded "WalrusAgent". Kept here so runtime.ts
// and every existing proof resolve the SAME name/bio they did before the character
// seam existed. AGENT_NAME in runtime.ts is derived from this.
export const DEFAULT_CHARACTER: AgentCharacter = {
  name: "WalrusAgent",
  bio: ["An agent backed by local chat memory (SQLite) and Walrus-backed checkpoints."],
};

export type LoadCharacterResult =
  | { ok: true; character: AgentCharacter }
  | { ok: false; kind: "not_found"; path: string; message: string }
  | { ok: false; kind: "invalid_json"; path: string; message: string }
  | { ok: false; kind: "invalid_markdown"; path: string; message: string }
  | { ok: false; kind: "invalid_character"; path: string; message: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Resolve a character reference to a file path. Rules, in order:
//   - absolute path                      -> used as-is.
//   - ref with a directory part (has a   -> resolved against cwd, so
//     "/" or "./", e.g. ./chars/my.md)      `--character ./characters/my.md` works.
//   - bare filename WITH an extension    -> looked up inside characters/
//     (e.g. example.md, example.json)        (a plain filename, not a cwd path).
//   - bare name WITHOUT an extension     -> characters/<name>.md if it exists, else
//     (e.g. researcher)                      characters/<name>.json.
// So both `--character example` and `--character example.md` find characters/example.md.
export function resolveCharacterPath(ref: string): string {
  const trimmed = ref.trim();
  if (isAbsolute(trimmed)) return trimmed;
  // A ref that names a directory (contains a separator) is a cwd-relative path.
  if (dirname(trimmed) !== ".") return resolve(process.cwd(), trimmed);
  // From here it is a bare filename: it belongs in characters/.
  if (extname(trimmed) !== "") return resolve(CHARACTERS_DIR, trimmed);
  const mdPath = resolve(CHARACTERS_DIR, `${trimmed}.md`);
  if (existsSync(mdPath)) return mdPath;
  return resolve(CHARACTERS_DIR, `${trimmed}.json`);
}

// Is this path a Markdown character file (by extension)? Drives format dispatch.
function isMarkdownPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

// One discovered character file: the bare name to pass to --character, plus its
// format. When BOTH name.md and name.json exist, only the .md entry is listed (it is
// the one a bare --character <name> resolves to), so the list matches what loads.
export interface CharacterListEntry {
  readonly name: string;
  readonly format: "markdown" | "json";
  readonly file: string;
}

// The character-file extensions we recognize, mapped to their list format label.
const LISTABLE_EXTENSIONS: ReadonlyMap<string, "markdown" | "json"> = new Map([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".json", "json"],
]);

/**
 * List the character files available in characters/, sorted by name. Returns an empty
 * array when the directory is absent or empty; NEVER throws. Markdown shadows JSON for
 * the same bare name (matching resolveCharacterPath's .md-preference), so each name
 * appears once with the format a bare --character <name> would load.
 */
export async function listCharacters(): Promise<CharacterListEntry[]> {
  let files: string[];
  try {
    files = await readdir(CHARACTERS_DIR);
  } catch {
    return []; // no characters/ dir yet
  }

  // Collect by bare name, preferring markdown when both formats exist for a name.
  const byName = new Map<string, CharacterListEntry>();
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const format = LISTABLE_EXTENSIONS.get(ext);
    if (format === undefined) continue;
    const name = basename(file, extname(file));
    const existing = byName.get(name);
    if (existing === undefined || (existing.format === "json" && format === "markdown")) {
      byName.set(name, { name, format, file });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Validate an arbitrary parsed value into an AgentCharacter. Pure (no I/O) so it is
 * unit-testable and reused by loadCharacter. Returns the typed character or an
 * invalid_character result naming the first problem. Unknown extra fields are
 * ignored — only the known shape is enforced.
 */
export function parseCharacter(path: string, parsed: unknown): LoadCharacterResult {
  const invalid = (message: string): LoadCharacterResult => ({
    ok: false,
    kind: "invalid_character",
    path,
    message,
  });

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("character file must contain a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (!isNonEmptyString(obj.name)) {
    return invalid('character "name" must be a non-empty string');
  }
  if (!Array.isArray(obj.bio) || obj.bio.length === 0 || !obj.bio.every(isNonEmptyString)) {
    return invalid('character "bio" must be a non-empty array of non-empty strings');
  }
  if (obj.systemPrompt !== undefined && !isNonEmptyString(obj.systemPrompt)) {
    return invalid('character "systemPrompt", if present, must be a non-empty string');
  }
  if (
    obj.templateCategoryIds !== undefined &&
    (!Array.isArray(obj.templateCategoryIds) ||
      !obj.templateCategoryIds.every(isNonEmptyString))
  ) {
    return invalid(
      'character "templateCategoryIds", if present, must be an array of non-empty strings',
    );
  }

  const character: AgentCharacter = {
    name: obj.name.trim(),
    bio: (obj.bio as string[]).map((line) => line.trim()),
    ...(obj.systemPrompt !== undefined ? { systemPrompt: (obj.systemPrompt as string).trim() } : {}),
    ...(obj.templateCategoryIds !== undefined
      ? { templateCategoryIds: (obj.templateCategoryIds as string[]).map((id) => id.trim()) }
      : {}),
  };
  return { ok: true, character };
}

/**
 * Load + validate a character file by reference (bare name, *.md/*.markdown, *.json,
 * or path). Returns a typed result; NEVER throws. A missing file is `not_found`,
 * malformed JSON is `invalid_json`, malformed Markdown frontmatter is
 * `invalid_markdown`, and a well-formed-but-wrong-shape file (either format) is
 * `invalid_character`. The format is chosen by extension; a bare name prefers .md.
 */
export async function loadCharacter(ref: string): Promise<LoadCharacterResult> {
  const path = resolveCharacterPath(ref);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return {
        ok: false,
        kind: "not_found",
        path,
        message: `character file not found: ${path}`,
      };
    }
    return {
      ok: false,
      kind: "not_found",
      path,
      message: `could not read character file ${path}: ${String(cause)}`,
    };
  }

  // Dispatch on format. Markdown -> frontmatter+body to a raw record; JSON -> parse.
  // Both then run through the SAME parseCharacter validator below.
  let parsed: unknown;
  if (isMarkdownPath(path)) {
    const md = parseMarkdownCharacter(text);
    if (!md.ok) {
      return {
        ok: false,
        kind: "invalid_markdown",
        path,
        message: `character file ${path} has invalid frontmatter: ${md.message}`,
      };
    }
    parsed = md.record;
  } else {
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return {
        ok: false,
        kind: "invalid_json",
        path,
        message: `character file ${path} is not valid JSON: ${String(cause)}`,
      };
    }
  }
  return parseCharacter(path, parsed);
}
