import { describe, expect, it } from "vitest";

import {
  ADMITTED_GHIDRA_MINOR_FLOOR,
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
  ghidraReleaseAccepted,
  ghidraReleaseCompatibility,
  ghidraReleaseLine,
  GHIDRA_CLANG_O0_SWITCH_DEFECT,
  ghidraKnownProviderDefect,
  ghidraKnownProviderDefectLimitation,
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
    expect(ghidraKnownProviderDefect("12.2")).toEqual({
      kind: "known-provider-defect",
      id: "ghidra-9996",
      provider_id: "ghidra",
      release: "12.2",
      fixed_in: "12.2.1",
      scope: {
        compiler: "clang",
        architecture: "x86-64",
        optimization: "-O0",
        construct: "switch",
        case_base: "above-zero",
      },
      effect: "jump-table-flow-references-omitted",
      fix_commit: "c93917a622211349998f641de54cfdbe0e0e5bee",
      upstream_issue:
        "https://github.com/NationalSecurityAgency/ghidra/issues/9996",
    });
    expect(ghidraKnownProviderDefect("12.2")).toBe(
      GHIDRA_CLANG_O0_SWITCH_DEFECT,
    );
    const limitation = ghidraKnownProviderDefectLimitation("12.2");
    expect(limitation).toEqual(
      ghidraKnownProviderDefectLimitation(SUPPORTED_GHIDRA_VERSION),
    );
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
      expect(limitation).toEqual(expect.stringContaining(fact));
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
      expect(ghidraKnownProviderDefect(raw)).toBeUndefined();
      expect(ghidraKnownProviderDefectLimitation(raw)).toBeUndefined();
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
