import { createCommandCli } from "../../support/cli/commandCli.js";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";

const registry = () => {
  const run = vi.fn(async () => ({
    ok: false as const,
    error: { code: "invalid_request", message: "Admitted query control" },
  }));
  const cli = createCommandCli();
  registerCoreNativeCommands(cli, pino({ enabled: false }), run);
  return { cli, run };
};

it("forwards admitted original strings and caller-selected search/provider controls", async () => {
  const { cli, run } = registry();
  await cli.serve(
    [
      "search-bytes",
      "/selected",
      "ab ?? CD",
      "--mask",
      "FF 00 ff",
      "--start",
      "0x10",
      "--end",
      "0x20",
      "--cursor",
      "next",
      "--limit",
      "7",
      "--provider",
      "ghidra",
      "--json",
    ],
    { stdout: () => undefined, exit: () => undefined },
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "/selected",
    "search_bytes",
    {
      pattern: "ab ?? CD",
      mask: "FF 00 ff",
      start: "0x10",
      end: "0x20",
      cursor: "next",
      limit: 7,
    },
    expect.objectContaining({ providerId: "ghidra" }),
  );
});

it("keeps an omitted mask omitted", async () => {
  const { cli, run } = registry();
  await cli.serve(["search-bytes", "/selected", "AB", "--json"], {
    stdout: () => undefined,
    exit: () => undefined,
  });
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "/selected",
    "search_bytes",
    { pattern: "AB", limit: 100 },
    expect.any(Object),
  );
});
