import { expect, it } from "vitest";

import {
  androidOtaPayloadMetadataSchema,
  type AndroidOtaPayloadMetadata,
} from "../formatMetadata/androidAndSystemMetadata.js";
import { androidOtaPayloadSummaryMetadataSchema } from "./androidOtaPayloadSummary.js";
import { summaryRootMetadata } from "./espFlashImageSummary.js";

const partition = (
  index: number,
  extractable: boolean,
): AndroidOtaPayloadMetadata["partitions"][number] => ({
  index,
  name: `p${String(index)}`,
  path: `p${String(index)}.img`,
  new_partition_info: { size: 4096, hash_hex: "00" },
  old_partition_info: null,
  version: null,
  run_postinstall: null,
  postinstall_path: null,
  filesystem_type: null,
  operation_counts: [{ type: "REPLACE", type_code: 0, count: 1 }],
  total_data_length: 4096,
  merge_operation_count: 0,
  estimate_cow_size: null,
  extractable,
});

const metadata = androidOtaPayloadMetadataSchema.parse({
  kind: "android-ota-payload",
  magic: "CrAU",
  major_version: 2,
  manifest_size: 128,
  metadata_signature_size: 0,
  manifest_offset: 24,
  blob_offset: 152,
  block_size: 4096,
  minor_version: 0,
  payload_kind: "full",
  max_timestamp: null,
  partial_update: null,
  security_patch_level: "2024-01-05",
  signatures_offset: null,
  signatures_size: null,
  metadata_signature_blob_size: 0,
  metadata_signature_count: null,
  payload_signature_blob_size: null,
  payload_signature_count: null,
  signatures_verified: false,
  snapshot_enabled: null,
  vabc_enabled: null,
  vabc_compression_param: null,
  blob_truncated: false,
  partitions: Array.from({ length: 300 }, (_, index) =>
    partition(index, index % 3 !== 0),
  ),
  dynamic_partition_groups: [
    { name: "group", size: null, partition_names: ["p1", "p2"] },
  ],
  apex_info: Array.from({ length: 5 }, () => ({
    package_name: "com.android.example",
    version: 1,
    is_compressed: false,
    decompressed_size: null,
  })),
});

it("summarizes an Android OTA payload's arrays as counts", () => {
  const summary = androidOtaPayloadSummaryMetadataSchema.parse(
    summaryRootMetadata(metadata),
  );
  expect(summary).toMatchObject({
    kind: "android-ota-payload-summary",
    payload_kind: "full",
    security_patch_level: "2024-01-05",
    signatures_verified: false,
    partition_count: 300,
    extractable_partition_count: 200,
    dynamic_partition_group_count: 1,
    apex_info_count: 5,
  });
  expect(summary).not.toHaveProperty("partitions");
  expect(summary).not.toHaveProperty("dynamic_partition_groups");
  expect(summary).not.toHaveProperty("apex_info");
  expect(JSON.stringify(summary).length).toBeLessThan(1024);
});
