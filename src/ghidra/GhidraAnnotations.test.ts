import { functionDossierSchema } from "../domain/hopperValues.js";
import { describe, expect, it } from "vitest";
import { nativeFunctionAnnotationsInputSchema } from "../domain/nativeFunctionAnnotations.js";
import { ghidraFunctionDossier } from "../domain/ghidraValues.fixture.js";
import {
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
} from "./GhidraFunctionValues.js";
import {
  CAPABILITIES,
  WINDOWS_P0_CAPABILITIES,
} from "./GhidraProviderCapabilities.js";
import { HOPPER_PROVIDER_TOOL_CONTRACTS } from "../hopper/HopperProvider.js";

const result = () => {
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  return {
    annotations: {
      address: dossier.procedure.address,
      name: dossier.procedure.name,
      comment: null,
      inline_comment: "Finding",
    },
    dossier,
    effects: {
      scope: "session-analysis-database",
      source_bytes_modified: false,
      persists_after_close: false,
    },
  };
};

describe("Ghidra function annotations", () => {
  it("requires an explicit function and at least one change without approval flags", () => {
    for (const input of [
      {},
      { procedure: "main" },
      { procedure: "", name: "entry" },
      { procedure: "main", name: "" },
      { procedure: "main", comment: null },
      { procedure: "main", name: "entry", approve: true },
    ])
      expect(
        nativeFunctionAnnotationsInputSchema.safeParse(input).success,
      ).toBe(false);
    expect(
      parseGhidraFunctionInput("annotate_native_function", {
        procedure: "0x10100",
        comment: "",
      }),
    ).toEqual({ ok: true, value: { procedure: "0x10100", comment: "" } });
  });

  it("preserves multiline Unicode text and omitted fields", () => {
    const input = { procedure: "entry", inline_comment: "Line one\n註記" };
    expect(parseGhidraFunctionInput("annotate_native_function", input)).toEqual(
      { ok: true, value: input },
    );
  });

  it("validates readback identity, exact effects and the complete Ghidra dossier", () => {
    const value = result();
    expect(
      parseGhidraFunctionResult("annotate_native_function", value).ok,
    ).toBe(true);
    for (const malformed of [
      { ...value, annotations: { ...value.annotations, name: "different" } },
      { ...value, annotations: { ...value.annotations, address: "0x9999" } },
      { ...value, effects: { ...value.effects, source_bytes_modified: true } },
      { ...value, effects: { ...value.effects, persists_after_close: true } },
      { ...value, dossier: { ...value.dossier, native_value_flow: null } },
    ])
      expect(
        parseGhidraFunctionResult("annotate_native_function", malformed).ok,
      ).toBe(false);
  });

  it("preserves qualified names in readback and the refreshed dossier", () => {
    const value = result();
    const name = "namespace::recovered_routine";
    expect(
      parseGhidraFunctionResult("annotate_native_function", {
        ...value,
        annotations: { ...value.annotations, name },
        dossier: {
          ...value.dossier,
          procedure: { ...value.dossier.procedure, name },
        },
      }).ok,
    ).toBe(true);
  });

  it("declares mutation only for the admitted operation and keeps Windows and Hopper unavailable", () => {
    expect(
      CAPABILITIES.find((c) => c.operation === "annotate_native_function"),
    ).toMatchObject({
      available: true,
      effects: { mutatesArtifact: true, mayShowUi: false },
    });
    expect(
      CAPABILITIES.find((c) => c.operation === "analyze_function"),
    ).toMatchObject({ effects: { mutatesArtifact: false } });
    expect(
      WINDOWS_P0_CAPABILITIES.find(
        (c) => c.operation === "annotate_native_function",
      ),
    ).toMatchObject({ available: false });
    expect(
      HOPPER_PROVIDER_TOOL_CONTRACTS.some(
        (c) => c.name === "annotate_native_function",
      ),
    ).toBe(false);
  });
});
