import { expect, it } from "vitest";
import { inspectErlangBeamInputSchema, erlangBeamSchema } from "./beam.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const jsonSchema = (schema: {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: "draft-2020-12";
      }) => unknown;
    };
  };
}): Record<string, unknown> =>
  schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;

it("applies the shared absolute local-path policy to the public input", () => {
  expect(
    inspectErlangBeamInputSchema.safeParse({ path: "app.beam" }).success,
  ).toBe(false);
  expect(inspectErlangBeamInputSchema.safeParse({ path: "" }).success).toBe(
    false,
  );
  expect(
    inspectErlangBeamInputSchema.safeParse({ path: "/artifacts/app\0.beam" })
      .success,
  ).toBe(false);
  expect(
    inspectErlangBeamInputSchema.safeParse({ path: "/artifacts/app.beam" })
      .success,
  ).toBe(true);

  const shared = jsonSchema(absoluteLocalPathStringSchema);
  const advertised = jsonSchema(inspectErlangBeamInputSchema);
  const path = (
    advertised.properties as Record<string, Record<string, unknown>>
  ).path;
  const {
    $schema: _schema,
    description: _sharedDescription,
    ...sharedPolicy
  } = shared;
  const { description: _pathDescription, ...pathPolicy } = path ?? {};
  expect(pathPolicy).toEqual(sharedPolicy);
  expect(path?.description).toBe("Absolute filesystem path to a BEAM file");
});

it("rejects extra caller arguments and admits a BEAM form with no tables", () => {
  expect(
    inspectErlangBeamInputSchema.safeParse({
      path: "/artifacts/app.beam",
      extra: true,
    }).success,
  ).toBe(false);
  const report = erlangBeamSchema.parse({
    artifact: {
      path: "/artifacts/app.beam",
      sha256: "a".repeat(64),
      bytes: 16,
    },
    form: { location: { offset: 0, bytes: 12 }, size: 4 },
    chunks: [],
    atoms: null,
    atom_encoding: null,
    exports: null,
    imports: null,
    lambdas: null,
    code: null,
    module: null,
    coverage: {
      status: "complete",
      examined_chunks: 0,
      atoms: 0,
      trailing_bytes: 0,
    },
    limitations: ["No atom table was present."],
  });
  expect(report.atoms).toBeNull();
  expect(report.module).toBeNull();
});

it("reparses retained BEAM Evidence that predates the trailing-bytes field", () => {
  // A record written by an earlier build carries no coverage.trailing_bytes;
  // the retained-Evidence view must still reparse it instead of failing.
  const legacy = {
    artifact: {
      path: "/artifacts/app.beam",
      sha256: "a".repeat(64),
      bytes: 40,
    },
    form: { location: { offset: 0, bytes: 24 }, size: 16 },
    chunks: [],
    atoms: null,
    atom_encoding: null,
    exports: null,
    imports: null,
    lambdas: null,
    code: null,
    module: null,
    coverage: { status: "complete", examined_chunks: 1, atoms: 0 },
    limitations: [],
  };
  const parsed = erlangBeamSchema.parse(legacy);
  // Preserved as unknown, not a fabricated zero, even though the bounds imply a
  // trailer; the producing build never measured it.
  expect(parsed.coverage.trailing_bytes).toBeUndefined();
  expect(parsed.coverage.status).toBe("complete");
});
