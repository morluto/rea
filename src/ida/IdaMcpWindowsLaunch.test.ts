import { beforeEach, expect, it, vi } from "vitest";

import { createIdaMcpConnection } from "./IdaMcpConnection.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpStdioTransport.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";

// The real PATH/PATHEXT lookup runs; only the Windows file system is simulated.
const files = vi.hoisted(() => ({
  present: new Set<string>(),
  heldStats: new Map<string, () => Promise<{ isFile(): boolean }>>(),
  /** Paths the caller may not inspect. */
  denied: new Set<string>(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: async (path: string) => {
    const held = files.heldStats.get(path);
    if (held !== undefined) return held();
    if (files.present.has(path)) return { isFile: () => true };
    if (files.denied.has(path))
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
beforeEach(() => {
  files.present.clear();
  files.heldStats.clear();
  files.denied.clear();
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
    {
      command,
      args: ["--stdio"],
      env: {},
      protocol: "native",
      mode: "attached",
      timeoutMs: 5000,
    },
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

it("reports an uninspectable Windows command candidate with its path and code, not as missing", async () => {
  files.denied.add("C:\\Tools\\ida-mcp.EXE");
  const { launches, failure } = await observeLaunch("ida-mcp", {
    SYSTEMROOT: "C:\\Windows",
    PATH: "C:\\Tools",
    PATHEXT: ".EXE",
  });
  expect(launches).toEqual([]);
  expect(String(failure)).toContain(
    'candidate "C:\\\\Tools\\\\ida-mcp.EXE" could not be inspected (EACCES)',
  );
  expect(String(failure)).not.toContain("was not found");
});

it("snapshots the child's environment with the injected platform's name semantics", async () => {
  files.present.add("C:\\Tools\\ida-mcp.EXE");
  const { launches } = await observeLaunch("ida-mcp", {
    SystemRoot: "C:\\Windows",
    Path: "C:\\Tools",
    PathExt: ".EXE",
  });
  // Windows names are case-insensitive: the snapshot folds them to one
  // spelling on whatever host runs the connection.
  expect(launches).toEqual([
    expect.objectContaining({
      command: "C:\\Tools\\ida-mcp.EXE",
      hostEnvironment: expect.objectContaining({
        SYSTEMROOT: "C:\\Windows",
        PATH: "C:\\Tools",
        PATHEXT: ".EXE",
      }),
    }),
  ]);
});

it.each(["close", "registration timeout"] as const)(
  "settles a stalled Windows command lookup on %s before the filesystem returns",
  async (trigger) => {
    const lookup = phaseGate<void, { isFile(): boolean }>();
    // A drive path would be launchable once stat returns.
    files.heldStats.set("C:\\offline\\tools\\ida-mcp.EXE", lookup.hold);
    const launcher = vi
      .fn<OwnedMcpLauncher>()
      .mockRejectedValue(new Error("unexpected launch"));
    const connection = createIdaMcpConnection(
      {
        command: "ida-mcp",
        args: [],
        env: {},
        protocol: "native",
        mode: "attached",
        timeoutMs: 50,
      },
      { PATH: "C:\\offline\\tools", PATHEXT: ".EXE" },
      { platform: "win32", launcher },
    );
    const refused = vi.fn<(cause: unknown) => void>();
    const closed = vi.fn<() => void>();
    vi.useFakeTimers();
    const connecting = connection.connect().catch(refused);
    let closing: Promise<void> | undefined;
    try {
      await lookup.reached(connecting, "Windows command lookup");
      if (trigger === "close") {
        closing = connection.close().then(closed);
        // Observe any rejection here while preserving it for the awaited cleanup.
        void closing.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toHaveBeenCalledOnce();
        expect(refused).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      } else {
        await vi.advanceTimersByTimeAsync(49);
        expect(refused).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(refused).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            constructor: AnalysisTimeoutError,
            operation: "ida_mcp_connect",
            timeoutMs: 50,
            diagnostics: { phase: "windows_path_lookup" },
          }),
        );
      }
    } finally {
      lookup.release({ isFile: () => true });
      try {
        await connecting;
        await (closing ?? connection.close());
      } finally {
        vi.useRealTimers();
      }
    }
    expect(launcher).not.toHaveBeenCalled();
  },
);
