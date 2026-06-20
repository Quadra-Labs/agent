// resolveBinary.ts — locate a provider CLI even when it is installed but not on PATH (a
// common case with winget/MSI installers that do not update PATH until a new shell). Order:
//   1. an explicit override path (e.g. CLOUDFLARED_PATH / NGROK_PATH) — trusted as-is,
//   2. known per-OS install locations that actually exist on disk,
//   3. the bare command name — let the OS resolve it from PATH.
// The returned value is passed straight to spawn() with shell:false, so a path containing
// spaces (e.g. "C:\\Program Files (x86)\\...") needs no quoting.

import { existsSync } from "node:fs";

export function resolveBinary(
  command: string,
  override: string | undefined,
  candidates: readonly string[],
): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return command;
}
