import { describe, expect, it } from "vitest";

import { openBinaryInputSchema } from "./sessionLifecycleInputs.js";

describe("open_binary existing project input", () => {
  it("accepts one explicit project and Program selection", () => {
    expect(
      openBinaryInputSchema.parse({
        path:
          process.platform === "win32"
            ? "C:\\projects\\Firmware.gpr"
            : "/projects/Firmware.gpr",
        provider_id: "ghidra",
        existing_project: {
          project_name: "Firmware",
          program: "/nested/program.bin",
        },
      }),
    ).toMatchObject({
      provider_id: "ghidra",
      existing_project: {
        project_name: "Firmware",
        program: "/nested/program.bin",
      },
    });
  });

  it("rejects unknown project-selection fields", () => {
    expect(
      openBinaryInputSchema.safeParse({
        path: process.platform === "win32" ? "C:\\x.gpr" : "/x.gpr",
        existing_project: {
          project_name: "x",
          program: "/program",
          heuristic: true,
        },
      }).success,
    ).toBe(false);
  });

  it("requires explicit Ghidra selection and rejects import options", () => {
    const path = process.platform === "win32" ? "C:\\x.gpr" : "/x.gpr";
    const existing_project = { project_name: "x", program: "/program" };
    expect(
      openBinaryInputSchema.safeParse({ path, existing_project }).success,
    ).toBe(false);
    expect(
      openBinaryInputSchema.safeParse({
        path,
        provider_id: "hopper",
        existing_project,
      }).success,
    ).toBe(false);
    expect(
      openBinaryInputSchema.safeParse({
        path,
        provider_id: "ghidra",
        existing_project,
        format: "dos-com",
      }).success,
    ).toBe(false);
  });
});
