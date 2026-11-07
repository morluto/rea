import { isAbsolute, basename } from "node:path";
import { z } from "zod";

/** Recovery for a packed Program selected where REA requires a project. */
export const GHIDRA_PACKED_PROGRAM_RECOVERY =
  "A .gzf is a packed program, not a .gpr project. Import it into a new project with Ghidra analyzeHeadless <project-directory> <project-name> -import <file.gzf> -noanalysis; select its .gpr and, if needed, set REA_GHIDRA_PROGRAM_NAME to the imported program name.";

/** A single expanded local project marker; archives must be restored first. */
export const ghidraProjectPathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, "Ghidra project path must be absolute")
  .superRefine((path, context) => {
    if (path.endsWith(".gpr") && basename(path).length > 4) return;
    context.addIssue({
      code: "custom",
      message: path.toLowerCase().endsWith(".gzf")
        ? GHIDRA_PACKED_PROGRAM_RECOVERY
        : "Select an expanded .gpr project marker; restore .grez archives first",
    });
  });

/** Headless -process accepts globs and flags; this workflow selects one root program. */
export const ghidraProgramNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      name.trim().length > 0 &&
      !name.startsWith("-") &&
      !/[\\/\0*?]/u.test(name),
    "Select one exact program name in the project root, without paths, flags or wildcards",
  );

export interface GhidraProjectSelection {
  readonly path: string;
  readonly programName?: string;
}
