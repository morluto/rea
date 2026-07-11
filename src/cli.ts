import { Cli, z } from "incur";
import { fileURLToPath } from "node:url";

import { runDoctor } from "./application/Doctor.js";
import { runDirectAnalysis } from "./application/DirectAnalysis.js";
import { runSetup } from "./application/Setup.js";
import { PRODUCT_IDENTITY } from "./identity.js";

/** Build the Incur command tree for the non-MCP CLI commands. */
export const createCli = (): ReturnType<typeof Cli.create> => {
  const cli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: "0.1.0",
    description: "Install, diagnose, and automate Hopper binary analysis.",
    mcp: {
      command: PRODUCT_IDENTITY.mcpCommand,
      instructions:
        "Open a local target with open_binary, analyze it, and close the session when finished.",
    },
    sync: {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      include: ["skills/*"],
      suggestions: [
        "open a binary and summarize it",
        "decompile a procedure",
        "diagnose my Hopper setup",
      ],
    },
  });

  cli.command("setup", {
    description: "Install prerequisites and configure binary analysis",
    options: z.object({
      yes: z
        .boolean()
        .default(false)
        .describe("Approve prerequisite installation"),
    }),
    alias: { yes: "y" },
    run: ({ options }) => runSetup(options.yes),
  });
  cli.command("doctor", {
    description: "Diagnose the local Hopper integration",
    options: z.object({
      target: z.string().optional().describe("Optional binary path to check"),
    }),
    run: ({ options }) => runDoctor(options.target),
  });
  cli.command("analyze", {
    description: "Analyze a binary through the shared Hopper core",
    args: z.object({
      path: z.string().describe("Binary or Hopper database path"),
    }),
    run: ({ args }) => runDirectAnalysis(args.path, "binary_overview", {}),
  });
  cli.command("decompile", {
    description: "Decompile an address through the shared Hopper core",
    args: z.object({
      path: z.string().describe("Binary path"),
      address: z.string().describe("Procedure address"),
    }),
    run: ({ args }) =>
      runDirectAnalysis(args.path, "procedure_pseudo_code", {
        procedure: args.address,
      }),
  });
  return cli;
};
