// killTree.ts — the single place that depends on `tree-kill`. Wrapping it keeps the
// dependency isolated (one import site) and gives callers a tiny, signal-defaulted API.
// On Windows tree-kill shells to `taskkill /pid <pid> /T /F`; on POSIX it walks and kills
// the child tree. We need this because the tunnel spawns grandchildren (the tsx/esbuild
// service, cloudflared/ngrok daemons) that a plain child.kill() would orphan — leaving the
// port held after Ctrl-C.

import treeKill from "tree-kill";

/**
 * Kill the process identified by `pid` and all of its descendants. A missing/already-dead
 * pid is a no-op; tree-kill's callback error is intentionally swallowed (the process may
 * have exited between the check and the kill).
 */
export function killTree(pid: number | undefined, signal: string = "SIGTERM"): void {
  if (pid === undefined) return;
  treeKill(pid, signal, () => {
    // Ignore: the process tree may already be gone, which is the desired end state.
  });
}
