import { describe, expect, it } from "vitest";

import {
  processCaptureOwnershipUnavailableReason,
  probeProcessCaptureCapability,
} from "../../../src/process/capture/ProcessCaptureCapability.js";

describe("process capture capability diagnostics", () => {
  it.each([
    {
      cause: Object.assign(
        new Error("Cannot find package '@lydell/node-pty-win32-x64'"),
        { code: "ERR_MODULE_NOT_FOUND" },
      ),
      guidance: /optional dependencies enabled/i,
    },
    {
      cause: Object.assign(
        new Error("compiled against a different Node.js version"),
        { code: "ERR_DLOPEN_FAILED" },
      ),
      guidance: /incompatible with this Node.js runtime/i,
    },
    {
      cause: new Error("spawn EACCES"),
      guidance: /operating-system or process-startup error/i,
    },
  ])(
    "reports the probe failure and recovery for $cause.message",
    async ({ cause, guidance }) => {
      const capability = await probeProcessCaptureCapability({
        platform: "linux",
        loadPty: async () => {
          throw cause;
        },
      });
      expect(capability).toMatchObject({
        available: false,
        backend: "node-pty",
      });
      if (capability.available) throw new Error("Expected probe failure");
      expect(capability.reason).toContain(cause.message);
      expect(capability.reason).toMatch(guidance);
    },
  );

  it("prepares Darwin ownership inspection before probing or admitting a PTY", async () => {
    let loaded = false;
    const capability = await probeProcessCaptureCapability({
      platform: "darwin",
      prepareOwnershipInspector: async () => {
        throw new Error(
          "macOS process ownership inspection requires the Apple Swift compiler via xcrun",
        );
      },
      loadPty: async () => {
        loaded = true;
        return await import("@lydell/node-pty");
      },
    });

    expect(loaded).toBe(false);
    expect(capability).toEqual({
      available: false,
      backend: "node-pty",
      reason: expect.stringContaining(
        "requires the Apple Swift compiler via xcrun",
      ),
    });
  });

  it("keeps the ownership limitation separate from native PTY support", () => {
    expect(processCaptureOwnershipUnavailableReason("win32")).toContain(
      "Windows PTY process capture",
    );
  });

  it("explains Windows capture admission before loading or spawning a PTY", async () => {
    let loaded = false;
    const capability = await probeProcessCaptureCapability({
      platform: "win32",
      loadPty: async () => {
        loaded = true;
        throw new Error("Windows admission must precede PTY loading");
      },
    });
    expect(loaded).toBe(false);
    expect(capability).toMatchObject({
      available: false,
      reason: expect.stringContaining("does not yet verify descendant cleanup"),
    });
    if (capability.available)
      throw new Error("expected Windows capture refusal");
    expect(capability.reason).toContain("WSL for Linux commands");
    expect(capability.reason).toContain(
      "Reinstalling the PTY backend does not enable native Windows capture",
    );
  });
});
