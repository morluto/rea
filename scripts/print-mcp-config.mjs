#!/usr/bin/env node
/**
 * Print a ready-to-paste MCP server config with absolute paths filled in.
 *
 * Usage:
 *   node scripts/print-mcp-config.mjs /path/to/binary
 *   node scripts/print-mcp-config.mjs /path/to/binary --kind database
 *   node scripts/print-mcp-config.mjs /path/to/binary --loader-args '["-l","Mach-O","--aarch64"]'
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/print-mcp-config.mjs <target-path> [--kind executable|database] [--loader-args JSON]";

let env;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string", multiple: true },
      "loader-args": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(usage + "\n");
    process.exit(0);
  }
  if (positionals.length !== 1 || !positionals[0])
    throw new Error("Expected one target path");
  for (const name of ["kind", "loader-args"]) {
    if (values[name]?.length > 1)
      throw new Error(`--${name} may only be specified once`);
  }
  const kind = values.kind?.[0] ?? "executable";
  if (kind !== "executable" && kind !== "database")
    throw new Error("--kind must be executable or database");
  env = { HOPPER_TARGET_PATH: resolve(positionals[0]), HOPPER_TARGET_KIND: kind };
  const encoded = values["loader-args"]?.[0];
  if (encoded !== undefined) {
    const args = JSON.parse(encoded);
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && !arg.includes("\0")))
      throw new Error("--loader-args must encode an array of strings without NUL bytes");
    env.HOPPER_LOADER_ARGS_JSON = encoded;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${usage}\n`);
  process.exit(1);
}

const config = {
  mcpServers: {
    rea: {
      command: "npx",
      args: [
        "-y",
        `${
          JSON.parse(
            await readFile(
              resolve(
                fileURLToPath(new URL("..", import.meta.url)),
                "package.json",
              ),
              "utf8",
            ),
          ).name
        }@latest`,
        "mcp",
      ],
      env,
    },
  },
};

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
