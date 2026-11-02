import { win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveWindowsProviderExecutable } from "../../src/composition/resolveWindowsProviderExecutable.js";
import { ReverseEngineeringService } from "../../src/application/reverse/ReverseEngineeringService.js";
import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";

const windowsLookup = (cwd: string, files: readonly string[]) => {
  const existingFiles = new Set(
    files.map((path) => win32.normalize(path).toLowerCase()),
  );
  return {
    cwd,
    isFile: (path: string): boolean =>
      existingFiles.has(win32.normalize(path).toLowerCase()),
  };
};

describe("resolveWindowsProviderExecutable", async () => {
  it("resolves a bare name from quoted and relative Windows PATH entries", async () => {
    const cwd = "C:\\work";
    const expected = "C:\\work\\Program Files\\REA Tools\\objdump.EXE";
    expect(
      await resolveWindowsProviderExecutable(
        "objdump",
        {
          PATH: `.;".\\Program Files\\REA Tools";D:\\unused`,
          PATHEXT: ".COM;.EXE;.BAT",
        },
        windowsLookup(cwd, [expected]),
      ),
    ).toBe(expected);
  });

  it("resolves a relative configured path against the caller's Windows CWD", async () => {
    expect(
      await resolveWindowsProviderExecutable(
        ".\\tools\\objdump.exe",
        {},
        windowsLookup("D:\\analysis", []),
      ),
    ).toBe("D:\\analysis\\tools\\objdump.exe");
  });

  it("resolves relative PATH hits to absolute drive paths", async () => {
    const expected = "D:\\analysis\\bin\\rizin.EXE";
    expect(
      await resolveWindowsProviderExecutable(
        "rizin",
        { PATH: ".\\bin", PATHEXT: ".EXE" },
        windowsLookup("D:\\analysis", [expected]),
      ),
    ).toBe(expected);
  });

  it("skips script extensions and preserves a caller-selected absolute path", async () => {
    const expected = "C:\\tools\\rizin.EXE";
    const selected = "C:\\tools\\rizin.exe";
    expect(
      await resolveWindowsProviderExecutable(
        "rizin",
        { PATH: "C:\\tools", PATHEXT: ".CMD;.BAT;.EXE;.COM" },
        windowsLookup("C:\\work", ["C:\\tools\\rizin.CMD", expected]),
      ),
    ).toBe(expected);
    expect(
      await resolveWindowsProviderExecutable(
        selected,
        {},
        windowsLookup("D:\\work", []),
      ),
    ).toBe(selected);
  });

  it("keeps unresolved bare command names unchanged", async () => {
    expect(
      await resolveWindowsProviderExecutable(
        "missing-tool",
        { PATH: ".\\tools", PATHEXT: ".EXE" },
        windowsLookup("C:\\work", []),
      ),
    ).toBe("missing-tool");
  });

  it("preserves an absolute UNC selection verbatim instead of re-rooting it", async () => {
    // win32.resolve appends a separator to a share root and rewrites forward
    // separators, so a UNC selection must bypass the CWD-relative resolution.
    const shareRoot = "\\\\server\\share";
    const forwardSlashed = "//server/share/Program Files/objdump.exe";
    const lookup = windowsLookup("D:\\work", []);
    expect(await resolveWindowsProviderExecutable(shareRoot, {}, lookup)).toBe(
      shareRoot,
    );
    expect(
      await resolveWindowsProviderExecutable(forwardSlashed, {}, lookup),
    ).toBe(forwardSlashed);
  });

  it("resolves a bare name through a UNC PATH entry", async () => {
    const expected = "\\\\server\\share\\bin\\objdump.EXE";
    expect(
      await resolveWindowsProviderExecutable(
        "objdump",
        { PATH: "\\\\server\\share\\bin;D:\\unused", PATHEXT: ".EXE" },
        windowsLookup("D:\\work", [expected]),
      ),
    ).toBe(expected);
  });

  it("keeps an unresolved bare name unchanged when PATH entries are UNC", async () => {
    expect(
      await resolveWindowsProviderExecutable(
        "missing-tool",
        { PATH: "\\\\server\\share\\empty", PATHEXT: ".EXE" },
        windowsLookup("D:\\work", []),
      ),
    ).toBe("missing-tool");
  });

  it("finds installed providers beyond the former 64-entry cutoff", async () => {
    const expected = "D:\\entry128\\objdump.EXE";
    const path = Array.from(
      { length: 129 },
      (_, index) => `D:\\entry${index}`,
    ).join(";");
    expect(
      await resolveWindowsProviderExecutable(
        "objdump",
        { PATH: path, PATHEXT: ".EXE" },
        windowsLookup("D:\\work", [expected]),
      ),
    ).toBe(expected);
  });

  it.each(["abort", "deadline"])(
    "bounds a stalled network PATH probe on %s",
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const isFile = vi.fn(() => new Promise<boolean>(() => {}));
      try {
        const result = resolveWindowsProviderExecutable(
          "objdump",
          { PATH: "\\\\unreachable\\share;D:\\tools" },
          {
            cwd: "D:\\work",
            isFile,
            signal: controller.signal,
            timeoutMs: 100,
          },
        );
        const rejected = expect(result).rejects.toMatchObject(
          mode === "abort" ? { name: "AbortError" } : { code: "ETIMEDOUT" },
        );
        if (mode === "abort") controller.abort();
        else await vi.advanceTimersByTimeAsync(100);
        await rejected;
        expect(isFile).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("admitted Windows provider lookup", () => {
  it.each(["cancel", "close", "deadline"])(
    "settles admitted lookup on %s without launching a provider",
    async (mode) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let rejectProbe!: (cause: unknown) => void;
      let started!: () => void;
      const probing = new Promise<void>((resolve) => {
        started = resolve;
      });
      const isFile = vi.fn(() => {
        started();
        return new Promise<boolean>((_resolve, reject) => {
          rejectProbe = reject;
        });
      });
      const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const commands = createReverseEngineeringCommandPort({});
      const service = new ReverseEngineeringService({
        commands: {
          ...commands,
          objdump: async (input, options) => ({
            ...(await commands.objdump(input)),
            executable: await resolveWindowsProviderExecutable(
              "objdump",
              { PATH: "D:\\unreachable;D:\\tools" },
              {
                cwd: "D:\\work",
                isFile,
                ...(options?.signal === undefined
                  ? {}
                  : { signal: options.signal }),
                timeoutMs: 100,
              },
            ),
          }),
        },
        run,
      });
      try {
        const result = service.inspectWithObjdump(
          { operation: "architectures", command_timeout_ms: 5_000 },
          { signal: controller.signal },
        );
        await probing;
        let closing: Promise<void> | undefined;
        if (mode === "close") closing = service.close();
        else if (mode === "cancel") controller.abort();
        else await vi.advanceTimersByTimeAsync(100);
        const settled = await result;
        expect(settled).toMatchObject({
          ok: false,
          error: {
            _tag:
              mode === "deadline"
                ? "AnalysisTimeoutError"
                : "AnalysisCancelledError",
          },
        });
        if (mode === "deadline" && !settled.ok) {
          expect(settled.error).toMatchObject({
            timeoutMs: 100,
            userMessage: expect.stringContaining("PATH lookup"),
            remediationAction: expect.stringContaining("REA_OBJDUMP_COMMAND"),
          });
        }
        await closing;
        rejectProbe(new Error("late network failure"));
        await Promise.resolve();
        expect(isFile).toHaveBeenCalledTimes(1);
        expect(run).not.toHaveBeenCalled();
      } finally {
        await service.close();
        vi.useRealTimers();
      }
    },
  );

  it("passes an absolute selected command through provider composition", async () => {
    const commands = createReverseEngineeringCommandPort(
      { REA_OBJDUMP_COMMAND: "C:\\tools\\objdump.exe" },
      "win32",
    );
    expect(
      (await commands.objdump({ path: "artifact", operation: "file_headers" }))
        .executable,
    ).toBe("C:\\tools\\objdump.exe");
  });
});
