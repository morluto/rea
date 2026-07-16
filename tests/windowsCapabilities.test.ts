import { describe, expect, it } from "vitest";

import {
  probeWindowsCapabilities,
  type WindowsCapabilityDependencies,
} from "../src/application/WindowsCapabilities.js";

const dependencies = (
  overrides: Partial<WindowsCapabilityDependencies> = {},
): WindowsCapabilityDependencies => ({
  platform: "win32",
  architecture: "x64",
  probeSymlinkCreation: () =>
    Promise.resolve({ available: false, reason: "EPERM" }),
  probeNoFollowOpen: () => ({
    available: false,
    reason: "O_NOFOLLOW is unavailable in this Node runtime",
  }),
  probePrivateAcl: () => ({
    available: false,
    reason: "Windows ACL enforcement is not implemented by this REA build",
  }),
  probeUnixDomainSocket: () => ({
    available: false,
    reason: "Node path-based IPC uses named pipes on Windows",
  }),
  probePty: () =>
    Promise.resolve({
      available: false,
      backend: "node-pty",
      reason: "probe unavailable",
    }),
  ...overrides,
});

describe("Windows host capability report", () => {
  it("keeps unavailable security controls explicit", async () => {
    await expect(probeWindowsCapabilities(dependencies())).resolves.toEqual({
      platform: "win32",
      architecture: "x64",
      capabilities: {
        symlink_creation: { available: false, reason: "EPERM" },
        no_follow_open: {
          available: false,
          reason: "O_NOFOLLOW is unavailable in this Node runtime",
        },
        private_acl: {
          available: false,
          reason:
            "Windows ACL enforcement is not implemented by this REA build",
        },
        unix_domain_socket: {
          available: false,
          reason: "Node path-based IPC uses named pipes on Windows",
        },
        pty: { available: false, reason: "probe unavailable" },
      },
    });
  });

  it("reports successful probes independently", async () => {
    const result = await probeWindowsCapabilities(
      dependencies({
        probeSymlinkCreation: () =>
          Promise.resolve({ available: true, reason: null }),
        probePty: () =>
          Promise.resolve({ available: true, backend: "node-pty" }),
      }),
    );

    expect(result.capabilities.symlink_creation).toEqual({
      available: true,
      reason: null,
    });
    expect(result.capabilities.pty).toEqual({
      available: true,
      reason: null,
    });
    expect(result.capabilities.private_acl.available).toBe(false);
  });
});
