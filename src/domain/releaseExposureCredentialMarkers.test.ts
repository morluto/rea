import { describe, expect, it } from "vitest";

import { scanCredentialMarkers } from "./releaseExposureCredentialMarkers.js";

const PLANTED = "release-exposure-planted-secret-7c2e9a";
const AWS_KEY = "AKIAPLANT9EXPOSUREXX";

describe("release exposure credential markers", () => {
  it("reports rule id and location without the matched bytes", () => {
    const scan = scanCredentialMarkers(
      [
        "-----BEGIN PRIVATE KEY-----",
        PLANTED,
        "-----END PRIVATE KEY-----",
        `token ${AWS_KEY}`,
        "github_pat_11AAAAAABBBBCCCCDDDDEE",
        "ordinary configuration",
      ].join("\n"),
      "resources/config.txt",
    );
    expect(scan.hits.map((hit) => hit.rule_id)).toEqual([
      "pem.private_key",
      "aws.access_key_id",
      "github.fine_grained_pat",
    ]);
    expect(scan.hits.map((hit) => hit.line)).toEqual([1, 4, 5]);
    const serialized = JSON.stringify(scan);
    expect(serialized).not.toContain(PLANTED);
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain("github_pat_11AAAAAABBBBCCCCDDDDEE");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
  });

  it("counts hits past the storage cap without retaining them", () => {
    const line = "npm_" + "a".repeat(36);
    const scan = scanCredentialMarkers(
      Array.from({ length: 40 }, () => line).join("\n"),
      "tokens.txt",
    );
    expect(scan.hits).toHaveLength(32);
    expect(scan.omitted_hits).toBe(8);
    expect(JSON.stringify(scan)).not.toContain(line);
  });
});
