// httpDispatcher.ts — pin a process-wide undici dispatcher with connection KEEP-ALIVE. Without it
// every outbound fetch (gateway writes, intake /deliver polling, competition calls, /ping probes)
// opens a fresh TCP+TLS connection and pays the full handshake (~0.5-0.8s) on EVERY request — so a
// sequence of round-trips stacks that setup cost over and over. Reusing one warm connection per
// host turns each subsequent call into a single network round-trip.
//
// `family: 4` mirrors intake-engine and sidesteps Node resolving `localhost` to IPv6 first while
// the Quadra services bind IPv4 (an intermittent connect failure). Idle sockets are kept ~30s,
// comfortably past the 10s delivery-poll cadence, so polls reuse the connection instead of
// re-handshaking. Import this module ONCE, as the first import of an entry point, before any fetch.
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000, family: 4 },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  }),
);
