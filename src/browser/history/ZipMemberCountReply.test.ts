import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
import { readHistoricalCaptureReply } from "./HistoricalCaptureReply.js";

it("accepts a SAZ member-count reply", async () => {
  const root = await createTestTempDirectory("rea-member-count-reply-");
  const path = join(root, "reply.json");
  await writeFile(
    path,
    JSON.stringify({
      ok: false,
      reason: "member-count",
      message:
        "Artifact admission reached artifact_limits.zip.member_count (1 count).",
      pointer: "",
      member_count: 1,
    }),
  );
  const resources = new ArtifactResourceScope();
  try {
    const decoded = await readHistoricalCaptureReply(
      path,
      join(root, "capture.saz"),
      resources,
    );
    expect(decoded.value).toMatchObject({
      ok: false,
      reason: "member-count",
      member_count: 1,
    });
  } finally {
    await resources.close();
  }
});
