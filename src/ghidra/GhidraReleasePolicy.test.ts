import { describe, expect, it } from "vitest";

import {
  ADMITTED_GHIDRA_MINOR_FLOOR,
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
  ghidraReleaseAccepted,
  ghidraReleaseCompatibility,
  ghidraReleaseLine,
  GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT,
  GHIDRA_CLANG_O0_SWITCH_DEFECT,
  ghidraKnownProviderDefects,
  ghidraKnownProviderDefectLimitations,
  ghidraVersionDetail,
  unverifiedGhidraBuildLimitation,
} from "./GhidraReleasePolicy.js";

describe("Ghidra release admission", () => {
  it("verifies the pinned build and JDK major", () => {
    expect(SUPPORTED_GHIDRA_VERSION).toBe("12.2");
    expect(SUPPORTED_GHIDRA_JAVA_MAJOR).toBe(25);
    expect(ADMITTED_GHIDRA_MINOR_FLOOR).toBe(2);
    expect(ghidraReleaseCompatibility("12.2")).toMatchObject({
      status: "verified",
      raw: "12.2",
    });
    expect(ghidraReleaseAccepted("12.2")).toBe(true);
    expect(unverifiedGhidraBuildLimitation("12.2")).toBeUndefined();
    expect(ghidraKnownProviderDefects("12.2")).toEqual([
      GHIDRA_CLANG_O0_SWITCH_DEFECT,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT,
    ]);
    const limitations = ghidraKnownProviderDefectLimitations("12.2");
    expect(limitations).toEqual(
      ghidraKnownProviderDefectLimitations(SUPPORTED_GHIDRA_VERSION),
    );
    const [closedSwitch, openSwitch] = limitations;
    for (const fact of [
      GHIDRA_CLANG_O0_SWITCH_DEFECT.id,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.release,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.fixed_in,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.fix_commit,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.upstream_issue,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.scope.compiler,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.scope.optimization,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.scope.architecture,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.scope.construct,
      GHIDRA_CLANG_O0_SWITCH_DEFECT.effect,
    ])
      expect(closedSwitch).toEqual(expect.stringContaining(fact));
    for (const fact of [
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.id,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.release,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.status,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.upstream_issue,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.scope.architecture,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.scope.optimization,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.scope.construct,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.scope.bound,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.scope.table,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.scope.source,
      GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT.effect,
    ])
      expect(openSwitch).toEqual(expect.stringContaining(fact));
    expect(openSwitch).not.toContain(GHIDRA_CLANG_O0_SWITCH_DEFECT.fix_commit);
    expect(ghidraVersionDetail("12.2")).toBe("12.2");
  });

  it("admits other builds on the floor as compatible", () => {
    for (const raw of ["12.2.1", "12.3", "12.2-DEV"]) {
      expect(ghidraReleaseCompatibility(raw).status).toBe("compatible");
      expect(ghidraReleaseAccepted(raw)).toBe(true);
      expect(unverifiedGhidraBuildLimitation(raw)).toBeTypeOf("string");
      expect(ghidraVersionDetail(raw)).toBe(
        `${raw}; compatible ${ghidraReleaseLine()} release (verified build ${SUPPORTED_GHIDRA_VERSION})`,
      );
    }
    for (const raw of ["12.2.0", "12.2.1", "12.2-DEV", "12.3"]) {
      expect(ghidraKnownProviderDefects(raw)).toEqual([]);
      expect(ghidraKnownProviderDefectLimitations(raw)).toEqual([]);
    }
    expect(ghidraReleaseLine()).toBe("12.x (>=12.2)");
  });

  it("rejects builds below the compile floor and other majors", () => {
    for (const raw of ["12.1.4", "12.1", "12.0.4", "11.4", "13.0.0"]) {
      expect(ghidraReleaseCompatibility(raw).status).toBe("unsupported");
      expect(ghidraReleaseAccepted(raw)).toBe(false);
      expect(unverifiedGhidraBuildLimitation(raw)).toBeUndefined();
      expect(ghidraVersionDetail(raw)).toBe(
        `${raw}; accepted releases are ${ghidraReleaseLine()} (verified build ${SUPPORTED_GHIDRA_VERSION})`,
      );
    }
  });

  it("leaves unreadable versions unresolved", () => {
    expect(ghidraReleaseCompatibility(null)).toEqual({
      status: "unresolved",
      raw: null,
    });
    expect(ghidraReleaseCompatibility("latest").status).toBe("unresolved");
    expect(ghidraReleaseAccepted(undefined)).toBe(false);
    expect(ghidraVersionDetail(undefined)).toBe("unknown");
    expect(ghidraVersionDetail("latest")).toBe("latest");
  });
});
