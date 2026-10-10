import { z } from "zod";

/** Local ASAR/directory reconstruction request. */
export const javascriptArtifactReconstructionInputSchema = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
  integrity_policy: z.enum(["fail", "record-and-continue"]).default("fail"),
});

/** Parsed local reconstruction request. */
export type JavaScriptArtifactReconstructionInput = z.infer<
  typeof javascriptArtifactReconstructionInputSchema
>;
