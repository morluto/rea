import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import { FlutterBuildProvider } from "./FlutterBuildProvider.js";

const zipWithMembers = async (name: string, members: readonly string[]) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const member of members) await writer.add(member, new TextReader("a"));
  const root = await createTestTempDirectory("rea-flutter-member-count-");
  const path = join(root, name);
  await writeFile(path, Buffer.from(await writer.close()));
  return path;
};

const identify = (path: string) => {
  const provider = new FlutterBuildProvider();
  return runWithAnalysisOperationSnapshot(
    { revision: 1, overrides: { "artifact.member_count": 1 } },
    async () => {
      try {
        return await provider.execute({
          operation: "identify_flutter_build",
          input: { path },
        });
      } finally {
        await provider.close();
      }
    },
  );
};

it("reports a Flutter ZIP past the session member count as a count", async () => {
  const path = await zipWithMembers("app.apk", ["a.txt", "b.txt"]);
  const result = await identify(path);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("artifact.member_count");
  expect(result.error.message).not.toContain("artifact_limits");
  expect(result.error.message).not.toContain("expansion allowance");
  expect(result.error.limit).toMatchObject({
    setting: "artifact.member_count",
    effective_value: 1,
    unit: "count",
    source: "runtime",
  });
  expect(result.error.limit).not.toHaveProperty("parameter");
});

it("identifies a one-member APK at the session member count", async () => {
  const path = await zipWithMembers("one.apk", ["a.txt"]);
  const result = await identify(path);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.result).toMatchObject({ flutter_detected: false });
});
