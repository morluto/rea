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
