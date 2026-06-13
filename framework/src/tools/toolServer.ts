// toolServer.ts — the in-process MCP tool server: server + client joined by the SDK's
// InMemoryTransport linked pair (pure in-memory, NO network listener — privacy by
// construction). Registration gives JSON Schema advertisement + server-side validation;
// the loop reads the descriptors back through the protocol, so prompt and enforcement
// cannot drift. THE SEAL: startToolServer returns a narrow ToolPort { list, call } whose
// MCP client lives in a closure. port.call NEVER throws — it validates args client-side
// (-> tool_input_invalid), maps isError/rejection -> tool_run_failed, unknown name ->
// tool_not_found.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AnyTool } from "./defineTool.js";
import { formatZodIssues } from "../errors.js";
import {
  toolNotFound,
  toolInputInvalid,
  toolRunFailed,
  type ToolError,
} from "./toolErrors.js";

/** One advertised tool. `inputSchema` is the server's emitted JSON Schema — the same
 *  object rendered into the model's prompt, so prompt and enforcement cannot drift. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** A tool-call result: ok+value, or a typed ToolError. The port NEVER throws. */
export type ToolCallOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ToolError };

/** The narrow surface ctx.tools exposes. list() is a synchronous fixed snapshot. */
export interface ToolPort {
  list(): readonly ToolDescriptor[];
  call(name: string, args: unknown): Promise<ToolCallOutcome>;
}

/** A running in-process tool server: the sealed port + its lifecycle handle. */
export interface ToolServerHandle {
  readonly port: ToolPort;
  /** Close the client+server pair. Idempotent. */
  close(): Promise<void>;
}

// Internal wire identity (the handshake requires an Implementation{name, version}).
const SERVER_INFO = { name: "agent-framework-tools", version: "1.0.0" } as const;
const CLIENT_INFO = { name: "agent-framework-loop", version: "1.0.0" } as const;

/**
 * Start the in-process MCP tool server and return its sealed port + handle. Registers
 * each tool's zod object schema (the SDK converts it to JSON Schema + validates args),
 * joins server/client over an InMemoryTransport pair (server connected first), then
 * snapshots the descriptors once. Handlers return a JSON-serializable value (encoded
 * into one text block); a handler throw surfaces as isError -> tool_run_failed.
 */
export async function startToolServer(
  tools: readonly AnyTool[],
): Promise<ToolServerHandle> {
  const server = new McpServer(SERVER_INFO);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: unknown) => {
        const value = await tool.handler(args as never);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(value === undefined ? null : value),
            },
          ],
        };
      },
    );
  }

  const client = new Client(CLIENT_INFO);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Snapshot the advertised descriptors ONCE through the protocol, so list() is the
  // server's own emission (JSON Schema included), not a parallel reconstruction.
  const listed = await client.listTools();
  const descriptors: readonly ToolDescriptor[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));

  // The original zod schemas by name, for the client-side argument gate.
  const schemaByName = new Map(tools.map((t) => [t.name, t.input]));

  const port: ToolPort = {
    list(): readonly ToolDescriptor[] {
      return descriptors;
    },
    async call(name: string, args: unknown): Promise<ToolCallOutcome> {
      const schema = schemaByName.get(name);
      if (schema === undefined) {
        return { ok: false, error: toolNotFound(name) };
      }
      // Client-side gate for deterministic typed errors; the original args still go
      // over the wire and the server re-parses them.
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: toolInputInvalid(name, formatZodIssues(parsed.error)),
        };
      }
      let result: Awaited<ReturnType<Client["callTool"]>>;
      try {
        result = await client.callTool({
          name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
      } catch (caught) {
        // SEAL: sanitize the cause to a message-only Error so no SDK-internal object
        // crosses the port.
        const readable = caught instanceof Error ? caught.message : String(caught);
        return { ok: false, error: toolRunFailed(name, new Error(readable)) };
      }
      const content = Array.isArray(result.content) ? result.content : [];
      const firstText = content.find(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" && c !== null &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      );
      if (result.isError === true) {
        // The SDK wraps a handler throw into an isError result whose text is the message.
        const message = firstText?.text ?? "tool call failed";
        return { ok: false, error: toolRunFailed(name, new Error(message)) };
      }
      if (firstText === undefined) {
        return {
          ok: false,
          error: toolRunFailed(name, new Error("tool result had no text content")),
        };
      }
      // Decode the JSON-encoded value; non-JSON text falls back to the raw string.
      try {
        return { ok: true, value: JSON.parse(firstText.text) };
      } catch {
        return { ok: true, value: firstText.text };
      }
    },
  };

  let closed = false;
  return {
    port,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await client.close();
      await server.close();
    },
  };
}
