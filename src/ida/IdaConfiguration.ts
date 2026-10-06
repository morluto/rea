import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

const common = {
  mode: z.enum(["attached", "headless"]).default("attached"),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(300_000),
  workspaceRoot: z
    .string()
    .refine(isAbsolute, "workspaceRoot must be absolute on the REA host")
    .optional(),
};
const registrationSchema = z.union([
  z
    .object({
      ...common,
      type: z.literal("stdio").optional(),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("http").optional(),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          url.username === "" &&
          url.password === ""
        );
      }, "IDA MCP must use a local HTTP endpoint without URL credentials"),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
]);

/** An upstream MCP registration plus REA's database lifecycle selection. */
export type IdaConfiguration = z.infer<typeof registrationSchema>;

/** Read one explicit registration without starting or installing a provider. */
export const readIdaConfiguration = (
  path: string,
): Result<IdaConfiguration, ConfigurationError> => {
  try {
    if (statSync(path).size > 65_536)
      return err(
        new ConfigurationError(
          "REA_IDA_MCP_CONFIG exceeds the 64 KiB registration size.",
        ),
      );
    const input: unknown = JSON.parse(readFileSync(path, "utf8"));
    const envelope = z
      .object({ mcpServers: z.object({ "ida-pro-mcp": z.unknown() }) })
      .safeParse(input);
    const parsed = registrationSchema.safeParse(
      envelope.success ? envelope.data.mcpServers["ida-pro-mcp"] : input,
    );
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(
            "REA_IDA_MCP_CONFIG must contain an IDA MCP command/args or local url registration; see docs/ida-provider.md.",
            { cause: parsed.error },
          ),
        );
  } catch (cause: unknown) {
    return err(
      new ConfigurationError(
        `Cannot read IDA MCP registration ${path}; provide a readable JSON configuration.`,
        { cause },
      ),
    );
  }
};
