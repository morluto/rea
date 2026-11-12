import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { runHostQuery } from "./HostQuery.js";

it("returns an inert Node query's actual output and status", async () => {
  expect(
    await runHostQuery(
      process.execPath,
      ["-e", "process.stdout.write('query result')"],
      undefined,
    ),
  ).toEqual({ stdout: "query result", exitCode: 0 });
});

it("preserves cancellation recorded by the actual command owner", async () => {
  const reason = new Error("caller cancelled host query");
  const failure = await runHostQuery(
    process.execPath,
    ["-e", "void 0"],
    AbortSignal.abort(reason),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "cancelled", cause: reason });
  if (!(failure instanceof ArtifactReaderFailure))
    throw new Error("expected owner cancellation");
  expect(failure.cause).toBe(reason);
});
