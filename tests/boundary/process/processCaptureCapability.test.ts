import { describe, expect, it } from "vitest";

import {
  processCaptureProbeFailureReason,
  processCaptureOwnershipUnavailableReason,
  probeProcessCaptureCapability,
} from "../../../src/application/ProcessCaptureCapability.js";

describe("process capture capability diagnostics", () => {
  it("distinguishes missing native modules from runtime ABI mismatches", () => {
    expect(
      processCaptureProbeFailureReason(
        Object.assign(
          new Error("Cannot find package '@lydell/node-pty-win32-x64'"),
          {
            code: "ERR_MODULE_NOT_FOUND",
          },
        ),
      ),
    ).toContain("optional dependencies enabled");
    expect(
      processCaptureProbeFailureReason(
        Object.assign(
          new Error("compiled against a different Node.js version"),
          {
            code: "ERR_DLOPEN_FAILED",
          },
        ),
      ),
    ).toContain("incompatible with this Node.js runtime");
  });

  it("returns the actual cause from the real probe boundary", async () => {
    const capability = await probeProcessCaptureCapability({
      platform: "darwin",
      loadPty: async () => {
        throw Object.assign(new Error("optional binary was not installed"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    expect(capability).toEqual({
      available: false,
      backend: "node-pty",
      reason: expect.stringContaining("optional binary was not installed"),
    });
  });

  it("preserves the actual diagnostic for a genuine probe failure", () => {
    expect(
      processCaptureProbeFailureReason(new Error("spawn EACCES")),
    ).toContain("spawn EACCES");
  });

  it("keeps the ownership limitation separate from native PTY support", () => {
    expect(processCaptureOwnershipUnavailableReason("win32")).toContain(
      "process-tree ownership",
    );
  });
});
