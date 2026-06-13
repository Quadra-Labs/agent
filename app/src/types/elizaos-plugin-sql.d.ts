// Local ambient declaration for @elizaos/plugin-sql 1.7.2.
//
// Why this file exists: the published package's `exports` map points its type
// entry at ./dist/node/index.d.ts, which re-exports "./index.node" -- but no
// index.node.d.ts ships, and the top-level "types" target (./types/index.d.ts)
// is also absent. Under moduleResolution: Bundler this leaves the module with no
// resolvable declarations (TS7016), even though the JS runtime exports are
// correct (verified in dist/node/index.node.js). Rather than disable type
// checking for the import, we declare exactly the runtime surface the demo uses.
//
// Keep this minimal and faithful to the real exports. If plugin-sql ships proper
// types in a later release, delete this shim.

declare module "@elizaos/plugin-sql" {
  import type { IDatabaseAdapter, Plugin, UUID } from "@elizaos/core";

  /** Config accepted by createDatabaseAdapter. PGlite uses dataDir; Postgres uses postgresUrl. */
  export interface DatabaseAdapterConfig {
    dataDir?: string;
    postgresUrl?: string;
  }

  /**
   * Create the embedded database adapter (PGlite when given dataDir). The bare
   * runtime must create this, run plugin migrations, and register it before
   * runtime.initialize().
   */
  export function createDatabaseAdapter(
    config: DatabaseAdapterConfig,
    agentId: UUID,
  ): IDatabaseAdapter;

  /** The plugin-sql Plugin object (owns the core DB schema + migrations). */
  export const plugin: Plugin;

  const sqlPlugin: Plugin;
  export default sqlPlugin;
}
