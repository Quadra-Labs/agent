// PM2 process definitions for the three example agents Quadra ships, each exposed to regular
// users through a Cloudflare quick tunnel. `npm run tunnel:example -- --agent <name>` opens the
// tunnel to the agent's AGENT_PORT, wires AGENT_PUBLIC_URL to the public *.trycloudflare.com
// hostname, serves the agent, and self-publishes that URL to the data gateway so the web can
// discover + chat with it. Per-agent identity (wallet, port) lives in app/.env.<name>.
//
//   pm2 start ecosystem.agents.config.js   # start/refresh all three
//   pm2 save                               # persist across reboot
//
// Quick tunnels are accountless: the public URL changes on each restart, but every boot
// re-publishes the new URL to the gateway, so discovery stays correct. For stable hostnames,
// set CLOUDFLARE_TUNNEL_TOKEN + AGENT_PUBLIC_URL in app/.env and the same command still works.

const cwd = "/home/ubuntu/agent/framework";

// cloudflared lives in /usr/local/bin; make sure the tunnel child can find it regardless of the
// PATH pm2's daemon was started with.
const PATH = `/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`;

const agent = (name, agentArg) => ({
  name,
  cwd,
  script: "npm",
  args: `run tunnel:example -- --agent ${agentArg}`,
  interpreter: "none",
  autorestart: true,
  // The tunnel + agent take a few seconds to come up; don't treat that as a crash loop.
  min_uptime: 15000,
  max_restarts: 20,
  restart_delay: 4000,
  // Give cloudflared time to tear its tunnel down on SIGINT before pm2 SIGKILLs the tree.
  kill_timeout: 10000,
  env: { PATH, TUNNEL_PROVIDER: "cloudflare" },
});

module.exports = {
  apps: [
    agent("eth-price-band-agent", "eth-price-band"), // EthPriceBandAgent      :3939
    agent("sol-price-band-agent", "sol-price-band"), // SolPriceBandAgent      :3940
    agent("poly-price-agent", "poly-price"),         // PolymarketPriceForecaster :3941
  ],
};
