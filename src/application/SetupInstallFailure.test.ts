import { describe, expect, it } from "vitest";

import { HOPPER_PUBLISHER } from "../domain/hopperPublisher.js";
import { setupInstallFailure } from "./SetupInstallFailure.js";

describe("macOS Hopper setup failure projection", () => {
  it("projects a publisher mismatch onto its own code and recovery", () => {
    const result = setupInstallFailure("publisher_verification_failed");
    expect(result).toMatchObject({
      status: "failed",
      code: "publisher_verification_failed",
    });
    for (const fact of [
      HOPPER_PUBLISHER.bundleIdentifier,
      HOPPER_PUBLISHER.teamIdentifier,
      "HOPPER_LAUNCHER_PATH",
      "rea setup",
    ])
      expect(result.remediation).toContain(fact);
    expect(result.remediation).toMatch(/nothing was copied or launched/i);
  });

  it("keeps a broken bundle distinct from a publisher mismatch", () => {
    const result = setupInstallFailure("bundle");
    expect(result).toMatchObject({ status: "failed", code: "bundle_invalid" });
    expect(result.remediation).toMatch(/bundle/i);
    expect(result.remediation).toMatch(/retry setup/i);
    expect(result.remediation).toMatch(/update REA/i);
  });

  it("keeps a host below the release minimum distinct from an unsupported host", () => {
    const incompatible = setupInstallFailure("incompatible_host_version");
    expect(incompatible).toMatchObject({
      status: "failed",
      code: "incompatible_host_version",
    });
    expect(incompatible.remediation).toContain("HOPPER_LAUNCHER_PATH");
    const unsupported = setupInstallFailure("unsupported_host");
    expect(unsupported.code).toBe("unsupported_host");
    expect(incompatible.remediation).not.toBe(unsupported.remediation);
  });
});

describe("Linux package-manager setup failure projection", () => {
  it("quotes the failing command and a sanitized bounded diagnostic", () => {
    const result = setupInstallFailure("authorization_or_package_manager", {
      packageFailure: {
        command: 'pkexec pacman -U "/tmp/hopper package.pkg.tar.xz"',
        exitCode: 1,
        stdout: "",
        stderr: "\u001b[31merror:\u001b[0m package conflict\nrefused",
        outputTruncated: false,
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      code: "authorization_or_package_manager_failed",
    });
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.remediation).toContain(
      'pkexec pacman -U "/tmp/hopper package.pkg.tar.xz"; exit 1',
    );
    expect(result.remediation).toContain("error: package conflict refused");
    expect(result.remediation).not.toContain("\u001b");
    expect(result.remediation).not.toContain("\n");
  });

  it("preserves the established remediation if no package output exists", () => {
    const result = setupInstallFailure("authorization_or_package_manager");
    expect(result).toMatchObject({
      status: "failed",
      code: "authorization_or_package_manager_failed",
    });
    expect(result.remediation).toMatch(/package.manager/i);
    expect(result.remediation).toMatch(/Linux runtime dependencies/i);
    expect(result.remediation).toContain("rea setup");
  });

  it("keeps truncated package output within its excerpt budget", () => {
    const result = setupInstallFailure("authorization_or_package_manager", {
      packageFailure: {
        command: "pacman -U hopper.pkg.tar.xz",
        exitCode: 1,
        stdout: "",
        stderr: `${"warning ".repeat(100)}final package conflict`,
        outputTruncated: true,
      },
    });
    if (result.status !== "failed") throw new Error("expected failure");
    const excerpt = result.remediation
      .split("its output: ")[1]
      ?.split(" Resolve")[0];
    expect(excerpt).toContain("output truncated");
    expect(excerpt?.length).toBeLessThanOrEqual(400);
  });
});

it.each([
  ["destination_inspection", "destination_inspection_failed"],
  ["archive_write", "archive_write_failed"],
  ["launcher_inspection", "launcher_inspection_failed"],
] as const)("retains %s as a distinct setup failure", (reason, code) => {
  expect(setupInstallFailure(reason).code).toBe(code);
});

describe("Linux Hopper launcher digest mismatch", () => {
  const mismatch = {
    packageFamily: "rpm",
    releaseVersion: "2.1.0",
    declaredSha256: "74b5".padEnd(64, "0"),
    observedSha256: "b41e".padEnd(64, "0"),
  } as const;

  it("names the feed and package digests instead of reporting a failed download", () => {
    const result = setupInstallFailure("integrity", {
      platform: "linux",
      launcherDigestMismatch: mismatch,
    });
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.code).toBe("integrity_mismatch");
    expect(result.launcherDigestMismatch).toEqual(mismatch);
    expect(result.remediation).toContain("signature verified");
    expect(result.remediation).toContain(mismatch.releaseVersion);
    expect(result.remediation).toContain(mismatch.observedSha256);
    expect(result.remediation).toContain(mismatch.declaredSha256);
    expect(result.remediation).toContain("stale feed metadata");
    // A launcher-path override cannot recover this: the mismatch is refused
    // before the archive is retained, so no cache entry backs the override.
    expect(result.remediation).not.toContain("HOPPER_LAUNCHER_PATH");
  });

  it("escapes the feed release version before rendering the remediation", () => {
    const forged = {
      ...mismatch,
      releaseVersion: "2.1.0\r\nrea: hopper is installed\u001b[2K",
    };
    const result = setupInstallFailure("integrity", {
      platform: "linux",
      launcherDigestMismatch: forged,
    });
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.launcherDigestMismatch).toEqual(forged);
    expect(result.remediation).toContain(
      "release 2.1.0 rea: hopper is installed;",
    );
    expect(result.remediation).not.toContain("\r");
    expect(result.remediation).not.toContain("\u001b");
  });

  it("keeps the generic recovery for an integrity failure without package facts", () => {
    expect(setupInstallFailure("integrity", { platform: "linux" })).toEqual({
      status: "failed",
      code: "integrity_mismatch",
      remediation:
        "The Hopper download failed integrity verification. Retry setup; if it repeats, update REA before installing.",
    });
  });
});
