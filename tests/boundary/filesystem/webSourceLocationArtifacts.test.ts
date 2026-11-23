import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { LocalWebSourceLocationArtifacts } from "../../../src/browser/assets/WebSourceLocationArtifacts.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ok } from "../../../src/domain/result.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  webSourceLocationArgs as args,
  webSourceLocationFixture,
} from "../../fixtures/webSourceLocation.js";

it("retains exact selected map bytes and completed reads across failures", async () => {
  const root = await createTestTempDirectory("rea-map-artifacts-");
  const good = join(root, "valid.map");
  const invalid = join(root, "invalid-utf8.map");
  const oversized = join(root, "oversized.map");
  const mapBytes = 128;
  const text = '\uFEFF{"version":3,"sources":[],"names":[],"mappings":""}';
  const malformed = Buffer.from([255, 254]);
  await Promise.all([
    writeFile(good, text),
    writeFile(invalid, malformed),
    writeFile(oversized, Buffer.alloc(mapBytes + 1)),
  ]);
  const file = (path: string, bytes: string | Buffer) => ({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: Buffer.byteLength(bytes),
  });
  const { sourceMap: _fixtureMap, ...script } = webSourceLocationFixture();
  const reader = new LocalWebSourceLocationArtifacts({
    load: async () => ok(script),
  });
  const load = (path: string) =>
    reader.load({
      ...args,
      source_map: { ...args.source_map, path },
      source_map_limits: { map_bytes: mapBytes },
    });
  onTestFinished(() => reader.close());
  const rejected = await load(invalid);
  if (rejected.ok) throw new Error("Accepted invalid UTF-8");
  expect(projectAnalysisError(rejected.error)).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["source_map", "path"],
          reason: "invalid_format",
          message: expect.stringContaining("UTF-8"),
        },
      ],
    },
  });
  expect(rejected.error.partialObservation).toMatchObject({
    kind: "web-artifact-acquisition",
    analysis: "not-performed",
    files: [
      { role: "manifest" },
      { role: "source" },
      { role: "source-map", admission: "read", file: file(invalid, malformed) },
    ],
  });

  const refused = await load(oversized);
  if (refused.ok) throw new Error("Accepted oversized map");
  expect(refused.error).toMatchObject({
    _tag: "ArtifactOperationError",
    reason: "limit",
    detail: expect.stringContaining(oversized),
    remediationAction: expect.stringContaining(
      "source_map_limits.map_bytes is 128 bytes",
    ),
  });

  const accepted = await load(good);
  if (!accepted.ok) throw accepted.error;
  expect(accepted.value.sourceMap).toEqual({
    file: file(good, text),
    url: args.source_map.url,
    text,
  });
});
