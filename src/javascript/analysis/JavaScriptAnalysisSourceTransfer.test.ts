import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const writeFileMock = vi.hoisted(() => vi.fn());
const windowsWriteTransientFile = vi.hoisted(() => vi.fn());
const windowsWriteFile = vi.hoisted(() => vi.fn());
const windowsPrivateRuntime = vi.hoisted(() =>
  vi.fn(() => ({
    writeTransientFile: windowsWriteTransientFile,
    writeFile: windowsWriteFile,
  })),
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      writeFileMock(...args),
  };
});

vi.mock("../../windows/WindowsPrivateRuntime.js", () => ({
  windowsPrivateRuntime,
}));

import { writeJavaScriptAnalysisSourceTransfer } from "./JavaScriptAnalysisSourceTransfer.js";

afterEach(() => {
  writeFileMock.mockReset();
  windowsWriteTransientFile.mockReset();
  windowsWriteFile.mockReset();
  windowsPrivateRuntime.mockReset();
  windowsPrivateRuntime.mockImplementation(() => ({
    writeTransientFile: windowsWriteTransientFile,
    writeFile: windowsWriteFile,
  }));
});

describe("writeJavaScriptAnalysisSourceTransfer", () => {
  it("uses the transient private-runtime write on Windows and never path-creates", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    writeFileMock.mockRejectedValue(eperm);
    const path = join("C:\\rea-javascript-analysis-fixture", "job.source");

    await writeJavaScriptAnalysisSourceTransfer(path, "source-bytes", {
      platform: "win32",
    });

    expect(windowsPrivateRuntime).toHaveBeenCalledWith(
      "C:\\rea-javascript-analysis-fixture",
    );
    expect(windowsWriteTransientFile).toHaveBeenCalledWith(
      "job.source",
      "source-bytes",
    );
    expect(windowsWriteFile).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("honors cancellation before a Windows private-runtime write", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");

    await expect(
      writeJavaScriptAnalysisSourceTransfer(
        join("C:\\rea-javascript-analysis-fixture", "job.source"),
        "source-bytes",
        { platform: "win32", signal: controller.signal },
      ),
    ).rejects.toBe("cancelled");
    expect(windowsPrivateRuntime).not.toHaveBeenCalled();
    expect(windowsWriteTransientFile).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("yields before the Windows write so a pending abort can fire", async () => {
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort("cancelled-during-yield");
    });

    await expect(
      writeJavaScriptAnalysisSourceTransfer(
        join("C:\\rea-javascript-analysis-fixture", "job.source"),
        "source-bytes",
        { platform: "win32", signal: controller.signal },
      ),
    ).rejects.toBe("cancelled-during-yield");
    expect(windowsWriteTransientFile).not.toHaveBeenCalled();
    expect(windowsPrivateRuntime).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("honors cancellation after a completed Windows private-runtime write", async () => {
    const controller = new AbortController();
    windowsWriteTransientFile.mockImplementation(() => {
      controller.abort("cancelled-after-write");
    });

    await expect(
      writeJavaScriptAnalysisSourceTransfer(
        join("C:\\rea-javascript-analysis-fixture", "job.source"),
        "source-bytes",
        { platform: "win32", signal: controller.signal },
      ),
    ).rejects.toBe("cancelled-after-write");
    expect(windowsWriteTransientFile).toHaveBeenCalledOnce();
    expect(windowsWriteFile).not.toHaveBeenCalled();
  });

  it("keeps exclusive owner-only create on POSIX", async () => {
    writeFileMock.mockImplementation(
      async (...args: Parameters<typeof writeFile>) => {
        const actual =
          await vi.importActual<typeof import("node:fs/promises")>(
            "node:fs/promises",
          );
        return actual.writeFile(...args);
      },
    );
    const root = await mkdtemp(join(tmpdir(), "rea-js-source-transfer-"));
    const path = join(root, "job.source");
    try {
      await writeJavaScriptAnalysisSourceTransfer(path, "source-bytes", {
        platform: "linux",
      });
      expect(await readFile(path, "utf8")).toBe("source-bytes");
      expect(writeFileMock).toHaveBeenCalledWith(path, "source-bytes", {
        flag: "wx",
        mode: 0o600,
        signal: undefined,
      });
      expect(windowsPrivateRuntime).not.toHaveBeenCalled();
      await expect(
        writeJavaScriptAnalysisSourceTransfer(path, "again", {
          platform: "linux",
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces EPERM from the POSIX exclusive create path", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    writeFileMock.mockRejectedValue(eperm);

    await expect(
      writeJavaScriptAnalysisSourceTransfer("/tmp/job.source", "source-bytes", {
        platform: "linux",
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(windowsPrivateRuntime).not.toHaveBeenCalled();
  });
});
