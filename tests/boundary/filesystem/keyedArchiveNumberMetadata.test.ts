import { it } from "vitest";

import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  archiveNumberMetadataCases,
  expectKeyedArchiveNumberMetadata,
  keyedArchiveNumberMetadataFixture,
} from "../../fixtures/keyedArchiveNumberMetadata.js";
import { cliTest } from "../../support/cli/cliFixture.js";

it.each(archiveNumberMetadataCases)(
  "filesystem preserves numeric meaning for $name",
  async (item) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const result = await inspectBundleKeyedArchive({
      bundlePath: fixture.root,
      targetSha256: fixture.digest,
      parameters: { path: "archive.plist" },
    });
    expectKeyedArchiveNumberMetadata(result, item, fixture.digest);
  },
);

cliTest.for(archiveNumberMetadataCases)(
  "built CLI preserves numeric meaning for $name",
  async (item, { cli }) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", fixture.path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expectKeyedArchiveNumberMetadata(
      parseEvidence(output.json).normalized_result,
      item,
      fixture.digest,
    );
  },
);
