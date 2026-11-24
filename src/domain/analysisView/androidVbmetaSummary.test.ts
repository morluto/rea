import { expect, it } from "vitest";

import { androidVbmetaMetadataSchema } from "../formatMetadata/androidAndSystemMetadata.js";
import { parseAndroidVbmeta } from "../firmware/androidVbmeta.js";
import { sampleAndroidVbmeta } from "../firmware/androidVbmeta.fixture.js";
import { androidVbmetaSummaryMetadataSchema } from "./androidVbmetaSummary.js";
import { summaryRootMetadata } from "./espFlashImageSummary.js";

const metadata = () => {
  const bytes = sampleAndroidVbmeta();
  const parsed = parseAndroidVbmeta(bytes, bytes.length);
  if (!parsed.ok) throw parsed.error;
  const base = androidVbmetaMetadataSchema.parse({
    kind: "android-vbmeta",
    ...parsed.value.metadata,
  });
  return androidVbmetaMetadataSchema.parse({
    ...base,
    descriptors: Array.from({ length: 40 }, () => base.descriptors[0]),
  });
};

it("summarizes vbmeta descriptors as counts", () => {
  const source = metadata();
  const summary = androidVbmetaSummaryMetadataSchema.parse(
    summaryRootMetadata(source),
  );
  expect(summary).toMatchObject({
    kind: "android-vbmeta-summary",
    algorithm_name: "SHA256_RSA2048",
    signatures_verified: false,
    descriptor_count: 40,
    property_count: 40,
    hashtree_count: 0,
    hash_count: 0,
    kernel_cmdline_count: 0,
    chain_partition_count: 0,
    unknown_count: 0,
  });
  expect(summary).not.toHaveProperty("descriptors");
  expect(JSON.stringify(summary).length).toBeLessThan(
    JSON.stringify(source).length,
  );
  expect(JSON.stringify(source)).toContain('"tag_name"');
  expect(JSON.stringify(summary)).not.toContain('"tag_name"');
});
