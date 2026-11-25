import { expect, it } from "vitest";
import { erlangBeamSchema } from "./beam.js";

it("admits a BEAM form with no tables", () => {
  const report = erlangBeamSchema.parse({
    artifact: {
      path: "/artifacts/app.beam",
      sha256: "a".repeat(64),
      bytes: 12,
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
