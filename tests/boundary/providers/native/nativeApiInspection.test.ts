import { describe, expect, it } from "vitest";

import { projectNativeApiInspection } from "../../../../src/application/NativeApiInspection.js";
import { functionDossierSchema } from "../../../../src/domain/hopperValues.js";
import { nativeApiBoundarySchema } from "../../../../src/domain/nativeApiBoundary.js";
import { ghidraFunctionDossier } from "../../../fixtures/ghidraFunction.js";

describe("native API inspection", () => {
  it("projects structured boundary evidence through inspectable substeps", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());

    expect(projectNativeApiInspection(dossier)).toMatchObject({
      schema_version: 1,
      procedure: { address: "0x401000", name: "fixture_main" },
      boundary: {
        available: true,
        return_type: { data_type: "int", confidence: "medium" },
        jump_tables: [
          {
            dispatch_address: "0x401010",
            data_sources: [{ address: "0x403000" }],
            mappings: [
              {
                target_address: "0x401020",
                data_addresses: ["0x403000"],
              },
            ],
          },
        ],
      },
      substeps: [
        { operation: "analyze_function", status: "completed" },
        { operation: "project_native_api_boundary", status: "completed" },
        { operation: "preserve_residual_unknowns", status: "completed" },
      ],
      unsupported_branches: [],
      residual_unknowns: [],
    });
  });

  it("preserves unsupported provider branches as residual unknowns", () => {
    const value = ghidraFunctionDossier();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("Ghidra dossier fixture is invalid");
    const dossier = functionDossierSchema.parse(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "native_api"),
      ),
    );

    expect(projectNativeApiInspection(dossier)).toMatchObject({
      boundary: { available: false },
      unsupported_branches: [
        "structured-boundary-types",
        "jump-table-data-mapping",
      ],
      residual_unknowns: [
        expect.stringContaining("boundary types"),
        expect.stringContaining("jump table"),
      ],
    });
  });

  it("rejects boundary types placed in the wrong ABI role", () => {
    const boundary = functionDossierSchema.parse(
      ghidraFunctionDossier(),
    ).native_api;
    if (boundary === null || boundary.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");

    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        return_type: { ...boundary.return_type, role: "parameter" },
      }).success,
    ).toBe(false);
    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        parameters: [
          {
            ...boundary.return_type,
            role: "return",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
