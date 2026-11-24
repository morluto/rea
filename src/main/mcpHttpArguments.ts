import { formatCommandHelp } from "../cli/help.js";
import type { McpHttpCommand } from "../cliBuiltinArguments.js";
import { z } from "zod";
import type { HttpHostname } from "../domain/httpHostname.js";

import {
  MCP_ALLOWED_HOSTS_FLAG_CONSTRAINT,
  MCP_HTTP_PORT_CONSTRAINT,
  mcpAllowedHostsTextSchema,
  mcpHttpListenerPortSchema,
  mcpHttpPortSchema,
} from "../config/mcpHttpEndpoint.js";

/**
 * Canonical `rea mcp --http` options. The help renderer lists exactly this
 * schema and the parser accepts exactly these flags plus the `-h` alias.
 */
const MCP_HTTP_OPTIONS = z.object({
  http: z
    .boolean()
    .describe("Serve the MCP catalog over streamable HTTP at /mcp, not stdio"),
  host: z
    .string()
    .min(1)
    .optional()
    .describe("Listener address; default MCP_HOST, else 127.0.0.1"),
  port: mcpHttpListenerPortSchema
    .optional()
    .describe("Listener port; default MCP_PORT, else 0 for an ephemeral port"),
  allowedHosts: z
    .array(z.string())
    .optional()
    .describe(
      "Host/Origin names a non-loopback bind may serve; repeat or separate names with commas; default MCP_ALLOWED_HOSTS, else the bind is refused",
    ),
  help: z.boolean().optional().describe("Show help"),
});

const MCP_HTTP_ALIAS = { help: "h" } as const;
const MCP_HTTP_COMMAND = "rea mcp --http";
const MCP_HTTP_DESCRIPTION =
  "Serve the MCP server over streamable HTTP for one local client";

/** Render help for the dispatcher entry, which accepts no global options. */
export const renderMcpHttpHelp = (): string =>
  formatCommandHelp(MCP_HTTP_COMMAND, {
    description: MCP_HTTP_DESCRIPTION,
    options: MCP_HTTP_OPTIONS,
    alias: MCP_HTTP_ALIAS,
    hint: "This entry accepts only the options above. The bound URL is logged as one JSON line on stderr.",
  });

/** Parsed `rea mcp --http` arguments; omitted values defer to the environment. */
export type McpHttpArguments =
  | {
      readonly ok: true;
      readonly host?: string;
      readonly port?: number;
      readonly allowedHosts?: readonly HttpHostname[];
    }
  | { readonly ok: false; readonly help: true }
  | { readonly ok: false; readonly help: false; readonly message: string };

const invalid = (message: string): McpHttpArguments => ({
  ok: false,
  help: false,
  message,
});

/** Validate the transport options selected by the executable dispatcher. */
export const validateMcpHttpCommand = (
  command: McpHttpCommand,
): McpHttpArguments => {
  if (command.kind === "help") return { ok: false, help: true };
  if (command.kind === "invalid") return invalid(command.message);
  const host = command.host?.trim();
  if (host !== undefined && host.length === 0)
    return invalid("--host must be a non-empty host name or IP address");
  const portText = command.port;
  const port =
    portText === undefined ? undefined : mcpHttpPortSchema.safeParse(portText);
  if (port !== undefined && !port.success)
    return invalid(`Invalid --port: ${MCP_HTTP_PORT_CONSTRAINT}`);
  const allowedHostsText =
    command.allowedHosts.length === 0
      ? undefined
      : command.allowedHosts.join(",");
  const allowedHosts =
    allowedHostsText === undefined
      ? undefined
      : mcpAllowedHostsTextSchema.safeParse(allowedHostsText);
  if (allowedHosts !== undefined && !allowedHosts.success)
    return invalid(
      `Invalid --allowed-hosts: ${MCP_ALLOWED_HOSTS_FLAG_CONSTRAINT}`,
    );
  return {
    ok: true,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port: port.data }),
    ...(allowedHosts === undefined ? {} : { allowedHosts: allowedHosts.data }),
  };
};
