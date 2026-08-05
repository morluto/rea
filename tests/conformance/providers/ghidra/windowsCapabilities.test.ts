import { describe, expect, it } from "vitest";

import {
  probeWindowsCapabilities,
  systemNoFollowOpenCapability,
  type WindowsCapabilityDependencies,
} from "../../../../src/application/WindowsCapabilities.js";
import { WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON } from "../../../../src/process/WindowsAuthority.js";

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
  it("never treats a numeric POSIX flag as Windows reparse authority", () => {
    expect(systemNoFollowOpenCapability("win32", 0x20_000)).toEqual({
      available: false,
      reason: "Windows reparse-safe handle admission is not implemented",
    });
    expect(systemNoFollowOpenCapability("linux", 0x20_000)).toEqual({
      available: true,
      reason: null,
    });
  });

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
      security: {
        job_object_process_ownership: {
          available: false,
          reason: WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON,
          proof: "not-proven",
        },
        private_runtime_dacl: {
          available: false,
          reason: WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON,
          proof: "not-proven",
        },
        reparse_safe_path_admission: {
          available: false,
          reason: WINDOWS_NATIVE_AUTHORITY_UNAVAILABLE_REASON,
          proof: "not-proven",
        },
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
    expect(result.security.private_runtime_dacl).toMatchObject({
      available: false,
      proof: "not-proven",
    });
  });

  it("does not promote an ordinary ACL probe into native authority", async () => {
    const result = await probeWindowsCapabilities(
      dependencies({
        probePrivateAcl: () => ({ available: true, reason: null }),
      }),
    );

    expect(result.capabilities.private_acl).toEqual({
      available: true,
      reason: null,
    });
    expect(result.security.private_runtime_dacl).toMatchObject({
      available: false,
      proof: "not-proven",
    });
  });
});
