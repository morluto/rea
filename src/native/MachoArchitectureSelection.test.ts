import { describe, expect, it } from "vitest";

import { selectLipoArchitecture } from "./MachoArchitectureSelection.js";
import type { LipoArchitecture } from "./parsers/lipo.js";

const record = (
  name: string,
  file_offset: number | null,
  size: number | null = 4096,
): LipoArchitecture => ({
  name,
  hidden: false,
  cpu_type: null,
  cpu_subtype: null,
  cpu_type_code: null,
  cpu_subtype_code: null,
  cpu_subtype_base: null,
  capabilities: null,
  file_offset,
  size,
  alignment: null,
  fields: {
    offset: { kind: "absent" },
    size: { kind: "absent" },
    align: { kind: "absent" },
  },
  limitations: [],
});

describe("selectLipoArchitecture", () => {
  it("refuses a policy-less name lipo lists twice instead of taking the first", () => {
    const available = [record("ppc", 4096), record("ppc", 8192)];
    expect(
      selectLipoArchitecture(
        { mode: "architecture", architecture: "ppc" },
        available,
      ),
    ).toMatchObject({ ok: false, error: { kind: "ambiguous_architecture" } });
    expect(
      selectLipoArchitecture({ mode: "architecture", architecture: "ppc" }, [
        record("ppc", 4096),
        record("i386", 8192),
      ]),
    ).toMatchObject({ ok: true, value: { toolName: "ppc" } });
  });

  it("separates an absent caller architecture from an undeclared admitted slice", () => {
    const available = [record("arm64", 4096)];
    expect(
      selectLipoArchitecture(
        { mode: "architecture", architecture: "x86" },
        available,
      ),
    ).toEqual({
      ok: false,
      error: {
        kind: "architecture_not_present",
        message: "lipo did not list i386; refusing to read another slice",
      },
    });
    expect(
      selectLipoArchitecture(
        {
          mode: "admitted",
          architecture: "arm64",
          slice: { offset: 8192, size: 4096 },
        },
        available,
      ),
    ).toMatchObject({ ok: false, error: { kind: "admitted_slice_mismatch" } });
  });

  it("refuses an admitted range lipo lists twice", () => {
    expect(
      selectLipoArchitecture(
        {
          mode: "admitted",
          architecture: "arm64",
          slice: { offset: 4096, size: 4096 },
        },
        [record("arm64", 4096), record("arm64e", 4096, null)],
      ),
    ).toMatchObject({ ok: false, error: { kind: "ambiguous_architecture" } });
  });
});
