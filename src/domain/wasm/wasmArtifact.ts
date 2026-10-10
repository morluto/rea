import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.strictObject({
  path: z.string().min(1),
  sha256: digest,
  bytes: z.number().int().nonnegative(),
});
/** All artifacts are explicitly selected local files; references never trigger acquisition. */
export const inspectWasmArtifactInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Absolute selected local WASM artifact path"),
  glue_paths: z.array(z.string().min(1)).max(16).default([]),
  candidate_paths: z.array(z.string().min(1)).max(16).default([]),
});
/** Upstream output stays intact; import/export names are never split on ambiguous punctuation. */
export const wasmArtifactSchema = z
  .strictObject({
    artifact,
    validation: z.literal("valid"),
    sections: z.array(
      z.strictObject({
        kind: z.string().min(1),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
        description: z.string(),
      }),
    ),
    imports: z.array(z.string()),
    exports: z.array(z.string()),
    headers: z.string(),
    details: z.string(),
    wat: z.strictObject({
      text: z.string().min(1),
      sha256: digest,
      representation: z.literal("decoded-wat"),
    }),
    tool_profile: z.strictObject({
      source: z.literal("https://github.com/WebAssembly/wabt"),
      release: z.literal("1.0.42"),
      source_commit: z.literal("ff0ef7e0009402740c805a9744c09b05be063e48"),
      commands: z
        .array(
          z.strictObject({
            tool: z.enum(["wasm-validate", "wasm-objdump", "wasm2wat"]),
            path: z.string().min(1),
            sha256: digest,
            version_banner: z.string(),
            arguments: z.array(z.string()),
          }),
        )
        .length(3),
      timeout_ms: z.number().int().positive(),
      output_budget_bytes: z.number().int().positive(),
    }),
    candidates: z.array(artifact),
    glue: z.array(
      z.strictObject({
        artifact,
        parse_status: z.enum(["complete", "partial", "failed"]),
        references: z.array(
          z.strictObject({
            value: z.string(),
            line: z.number().int().positive(),
            column: z.number().int().nonnegative(),
            candidate_paths: z.array(z.string()),
            association: z.enum([
              "local-path-candidate",
              "basename-candidates",
              "unresolved",
            ]),
            evidence_kind: z.literal("static-literal"),
          }),
        ),
      }),
    ),
    runtime_execution: z.literal("not-performed"),
    network_fetch: z.literal("not-performed"),
    limitations: z.array(z.string()),
  })
  .superRefine((value, context) => {
    const selected = value.candidates[0];
    if (
      selected?.path !== value.artifact.path ||
      selected.sha256 !== value.artifact.sha256 ||
      selected.bytes !== value.artifact.bytes
    )
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Selected candidate does not match artifact identity.",
      });
    for (const [index, command] of value.tool_profile.commands.entries()) {
      const expected = ["wasm-validate", "wasm-objdump", "wasm2wat"][index];
      const argumentsExpected =
        command.tool === "wasm-objdump"
          ? ["-h", "-x", "module.wasm"]
          : ["--enable-all", "module.wasm"];
      if (
        command.tool !== expected ||
        command.version_banner.trim() !== "1.0.42" ||
        JSON.stringify(command.arguments) !== JSON.stringify(argumentsExpected)
      )
        context.addIssue({
          code: "custom",
          path: ["tool_profile", "commands", index],
          message: "Unexpected WABT command profile.",
        });
    }
    for (const [index, section] of value.sections.entries())
      if (
        section.end > value.artifact.bytes ||
        section.end - section.start !== section.bytes
      )
        context.addIssue({
          code: "custom",
          path: ["sections", index],
          message: "Section range does not match selected artifact bytes.",
        });
  });
export type InspectWasmArtifactInput = z.infer<
  typeof inspectWasmArtifactInputSchema
>;
