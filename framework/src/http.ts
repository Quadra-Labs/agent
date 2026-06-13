// http.ts — the outbound-network choke-point shared by SkillContext and LoopContext.
// Its own module (neutral, importable by both) to avoid a defineSkill<->loopContext
// import cycle. Runtime-free: routes through the global fetch, so it is unit-testable.
// The single seam where per-skill timeout/allow-list/rate-limit can later land.

/**
 * The outbound-HTTP wrapper. getJson/getText throw on a non-2xx response (-> the
 * dispatcher's run_failed), never a silently-empty success.
 */
export interface LoopHttp {
  getJson(url: string, init?: unknown): Promise<unknown>;
  getText(url: string, init?: unknown): Promise<string>;
}

/**
 * Build the framework http wrapper over the global fetch. Runtime-free. A non-2xx
 * response throws a clear Error naming the status + url.
 */
export function makeHttp(): LoopHttp {
  return {
    async getJson(url: string, init?: unknown): Promise<unknown> {
      const res = await fetch(url, init as RequestInit | undefined);
      if (!res.ok) {
        throw new Error(`http.getJson ${res.status} for ${url}`);
      }
      return res.json();
    },
    async getText(url: string, init?: unknown): Promise<string> {
      const res = await fetch(url, init as RequestInit | undefined);
      if (!res.ok) {
        throw new Error(`http.getText ${res.status} for ${url}`);
      }
      return res.text();
    },
  };
}
