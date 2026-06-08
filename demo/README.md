# Walrus Agent Demo

A standalone, runnable slice of the agent framework. It is a terminal chat app
that shows three things working together: a local SQLite-style chat memory, a
MemWal checkpoint tier that stores condensed session summaries on the Walrus
testnet, and a job-intake assistant that matches your request to a job template
(also stored on Walrus), confirms it, and collects each parameter in plain
conversation. It needs only a Groq API key.

## Run

```
npm i
cp .env.example .env      # then put your Groq key in .env
npm start
```

Requirements: internet access (it uses the live Walrus testnet) and a Groq API
key. Nothing else -- no Sui wallet, no other services.

## Commands

- `/help` -- list commands.
- `/history` -- print this session's chat exactly as stored in the local DB.
- `/close` -- condense the session into a checkpoint, write it to MemWal on
  Walrus, then start a fresh session.
- `/resume` -- recall the latest checkpoint from MemWal and continue from it.
- `/sessions` -- list the checkpoints recorded on Walrus.
- `/exit` (or `/quit`) -- stop the agent and quit.

Anything else you type is sent to the agent.

## What you are seeing

- Chat -> the local SQLite-style DB (`/history` reads it back).
- `/close` -> a condensed checkpoint written to MemWal on the Walrus testnet.
- `/resume` -> that checkpoint recalled from Walrus so the agent continues with
  prior context.
- Describe a prediction or finance job (for example, "predict the price of
  bitcoin") and the agent matches the closest job, asks "is this the job you
  mean?", then collects each parameter conversationally without ever showing you
  the raw template.

The demo stops at a confirmed, parameter-complete job intent. In the full system
the agent would hand off to the Intake Engine for pricing and your cost approval;
here there is no Intake call, no oracle/market data, and no payment.

## Notes

- Live Walrus testnet only. There is no local fallback: if Walrus is unreachable,
  the demo fails loudly rather than faking storage.
- No Seal, no Intake, no oracle in this demo. Checkpoints are plain blobs.
- Verify it non-interactively with `npm run smoke:agent` (needs the Groq key).

## Files

- `src/index.ts` -- entry point and startup banner.
- `src/repl.ts` -- the interactive terminal loop and commands.
- `src/agent.ts` / `src/character.ts` -- one agent turn and the system prompt.
- `src/templates.ts` -- the job templates stored on Walrus.
- `src/memwal.ts` -- write/read session checkpoints on Walrus.
- `src/state.ts` -- local pointers (templates blobId, checkpoint index).
- `src/config.ts`, `src/runtime.ts`, `src/chatMemory.ts`, `src/walrusHttp.ts` --
  the foundation (config, runtime boot, local chat memory, Walrus HTTP client).
