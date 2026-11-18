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
    expect(ghidraKnownProviderDefectLimitation("12.2")).toBe(
      "Known provider defect ghidra-9996: Ghidra 12.2 can omit jump-table flow references and emit incorrect decompiler output for Clang -O0 x86-64 switches whose case labels start above zero. Upstream issue https://github.com/NationalSecurityAgency/ghidra/issues/9996 is closed by c93917a622211349998f641de54cfdbe0e0e5bee, milestone 12.2.1, which is not yet released. This limitation is recorded only for the exact 12.2 build and clears on 12.2.1. REA's verified switch lane compiles with -O2 and does not cover this shape.",
    );
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
