import { expect, it } from "vitest";

import { exportBuild } from "./DesktopBuildExport.js";

it.each([4, 8])(
  "gives the export time for both passes over %i readers",
  async (count) => {
    let passed: { timeout_s?: number } | undefined;
    let routeTimeout: number | undefined;
    const computer = {
      exec: (argv: readonly string[], timeout: number) => {
        if (argv[4] === "run-begin")
          passed = JSON.parse(argv.slice(5).join("")) as { timeout_s?: number };
        routeTimeout = Math.max(routeTimeout ?? 0, timeout);
        return Promise.resolve({
          exit_code: 0,
          stdout: '{"refused":"stopped for test"}\n',
          stderr: "",
          truncated: false,
          timed_out: false,
        });
      },
      homeFiles: () => Promise.resolve(new Map()),
      redacted: (text: string) => text,
    };
    const readers = Array.from({ length: count }, (_, index) => ({
      id: `r${String(index)}`,
      file: `f${String(index)}.bin`,
      argv: ["cat", "{file}"],
      output: "lines" as const,
      timeout_s: 300,
    }));
    await exportBuild(
      computer,
      { folder: ".rea-build/c", attempt: 0, extraPackages: [] },
      {
        directory: "/unused",
        task: {
          name: "t",
          prompt: "Task",
          checks: [
            {
              kind: "lines_present",
              file: "f0.bin",
              lines: ["x"],
              reader: "r0",
            },
          ],
          readers,
        },
      },
      new AbortController().signal,
    );
    expect(passed?.timeout_s).toBeGreaterThanOrEqual(
      1800 + 2 * count * (300 + 30),
    );
    // The computer-exec/v1 protocol accepts no single call over 3,600 s.
    expect(routeTimeout).toBeLessThanOrEqual(3600);
  },
);

it.each([
  [[260, 260, 260], "run", 3600],
  [[261, 260, 260], "run-begin", 90],
] as const)(
  "keeps the computer-exec deadline within its protocol limit",
  async (timeouts, expected, routeTimeout) => {
    let command: string | undefined;
    let observedTimeout: number | undefined;
    const computer = {
      exec: async (argv: readonly string[], timeout: number) => {
        command = argv[4];
        observedTimeout = timeout;
        return {
          exit_code: 0,
          stdout: '{"refused":"stop for test"}\n',
          stderr: "",
          timed_out: false,
          truncated: false,
        };
      },
      homeFiles: async () => new Map(),
      redacted: (text: string) => text,
    };
    await exportBuild(
      computer,
      { folder: ".rea-build/c", attempt: 0, extraPackages: [] },
      {
        directory: "/unused",
        task: {
          name: "t",
          prompt: "Task",
          checks: [
            {
              kind: "lines_present",
              file: "f0.bin",
              lines: ["x"],
              reader: "r0",
            },
          ],
          readers: timeouts.map((timeout_s, index) => ({
            id: `r${String(index)}`,
            file: `f${String(index)}.bin`,
            argv: ["cat", "{file}"],
            output: "lines" as const,
            timeout_s,
          })),
        },
      },
      new AbortController().signal,
    );
    expect(command).toBe(expected);
    expect(observedTimeout).toBe(routeTimeout);
  },
);
