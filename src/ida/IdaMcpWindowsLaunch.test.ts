import { beforeEach, expect, it, vi } from "vitest";

import { createIdaMcpConnection } from "./IdaMcpConnection.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpStdioTransport.js";
import { waitFor } from "../../tests/support/testWait.js";

// The real PATH/PATHEXT lookup runs; only the Windows file system is simulated.
const files = vi.hoisted(() => ({
  present: new Set<string>(),
  /** Paths whose stat never settles, like an unreachable network directory. */
  stalled: new Set<string>(),
  statted: [] as string[],
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: async (path: string) => {
    files.statted.push(path);
    if (files.stalled.has(path)) return new Promise<never>(() => undefined);
    if (files.present.has(path)) return { isFile: () => true };
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
beforeEach(() => {
  files.present.clear();
  files.stalled.clear();
  files.statted.length = 0;
});

const observeLaunch = async (
  command: string,
  environment: NodeJS.ProcessEnv = { SYSTEMROOT: "C:\\Windows" },
): Promise<{ launches: unknown[]; failure: unknown }> => {
  const launches: unknown[] = [];
  const launcher: OwnedMcpLauncher = async (options) => {
    launches.push(options);
    throw new Error("launch observed");
  };
  const connection = createIdaMcpConnection(
    { command, args: ["--stdio"], env: {}, mode: "attached", timeoutMs: 5000 },
    environment,
    { platform: "win32", launcher },
  );
  try {
    const failure: unknown = await connection.connect().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    return { launches, failure };
  } finally {
    await connection.close();
  }
};

it("launches a Windows batch registration through the shared cmd.exe invocation", async () => {
  files.present.add("C:\\Tools\\ida-mcp.cmd");
  const { launches } = await observeLaunch("C:\\Tools\\ida-mcp.cmd");
  expect(launches).toEqual([
    expect.objectContaining({
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: [
        "/d",
        "/e:on",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Tools\\ida-mcp.cmd" "--stdio""',
      ],
      windowsVerbatimArguments: true,
      stdin: "pipe",
    }),
  ]);
});

it("appends PATHEXT to an extensionless path-qualified interpreter", async () => {
  files.present.add("C:\\Python313\\python.EXE");
  const { launches } = await observeLaunch("C:\\Python313\\python", {
    SYSTEMROOT: "C:\\Windows",
    PATHEXT: ".COM;.EXE",
  });
  expect(launches).toEqual([
    expect.objectContaining({ command: "C:\\Python313\\python.EXE" }),
  ]);
});

it("refuses a network-share executable before launch with a drive-letter remedy", async () => {
  files.present.add("\\\\server\\tools\\python.exe");
  const { launches, failure } = await observeLaunch(
    "\\\\server\\tools\\python.exe",
  );
  expect(launches).toEqual([]);
  expect(String(failure)).toContain("drive letter");
});

it("closes while a Windows command lookup is stalled on an unreachable PATH directory", async () => {
  files.stalled.add("\\\\offline\\tools\\ida-mcp.EXE");
  const launches: unknown[] = [];
  const connection = createIdaMcpConnection(
    {
      command: "ida-mcp",
      args: [],
      env: {},
      mode: "attached",
      timeoutMs: 5000,
    },
    {
      SYSTEMROOT: "C:\\Windows",
      PATH: "\\\\offline\\tools",
      PATHEXT: ".EXE",
    },
    {
      platform: "win32",
      launcher: async (options) => {
        launches.push(options);
        throw new Error("launch observed");
      },
    },
  );
  const connecting = connection.connect().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  await waitFor(() =>
    expect(files.statted).toContain("\\\\offline\\tools\\ida-mcp.EXE"),
  );
  // Closing ends the lookup instead of waiting on the stalled directory.
  await connection.close();
  await expect(connecting).resolves.toBeDefined();
  expect(launches).toEqual([]);
});
