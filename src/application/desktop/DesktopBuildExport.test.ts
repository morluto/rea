import { expect, it } from "vitest";

import { exportBuild } from "./DesktopBuildExport.js";

it("gives the export time for both passes over all requested readers", async () => {
  let passed: { timeout_s?: number } | undefined;
  let routeTimeout: number | undefined;
  const computer = {
    exec: (argv: readonly string[], timeout: number) => {
      passed = JSON.parse(argv.slice(5).join("")) as { timeout_s?: number };
      routeTimeout = timeout;
      return Promise.resolve({
        exit_code: 0,
        stdout: '{"error":"stopped for test"}\n',
        stderr: "",
        truncated: false,
        timed_out: false,
      });
    },
    homeFiles: () => Promise.resolve(new Map()),
    redacted: (text: string) => text,
  };
  const readers = Array.from({ length: 4 }, (_, index) => ({
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
          { kind: "lines_present", file: "f0.bin", lines: ["x"], reader: "r0" },
        ],
        readers,
      },
    },
    new AbortController().signal,
  );
  expect(passed?.timeout_s).toBeGreaterThanOrEqual(1800 + 2 * 4 * (300 + 30));
  expect(routeTimeout).toBe((passed?.timeout_s ?? 0) + 60);
});
