import { collectEntries } from "../../tests/fixtures/artifactEntries.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { AvbVbmetaArtifactReader } from "./AvbVbmetaArtifactReader.js";
import { malformedArtifact } from "../resources/index.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import {
  buildVbmetaImage,
  buildVbmetaImageWithAllDescriptors,
  propertyDescriptor,
} from "../../tests/fixtures/avbVbmeta.js";
import { artifactReaderLifecycleCases } from "../../tests/fixtures/artifactReaderLifecycle.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const fixture = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-avb-vbmeta-boundary-"),
    "image",
  );
  await writeFile(path, bytes);
  return path;
};

it("does not publish preparation metadata or coverage after carrier mutation", async () => {
  const bytes = buildVbmetaImageWithAllDescriptors();
  const path = await fixture(bytes);
  class ChangedDuringPreparation extends AvbVbmetaArtifactReader {
    protected override async prepareEntries(signal?: AbortSignal) {
      const prepared = await super.prepareEntries(signal);
      await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
      return prepared;
    }
  }
  const reader = new ChangedDuringPreparation(path);
  const onCoverage = vi.fn();
  let yielded = 0;
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries(undefined, { onCoverage }))
          yielded += 1;
      })(),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(yielded).toBe(0);
    expect(onCoverage).not.toHaveBeenCalled();
    expect(reader.formatMetadata()).toBeUndefined();
  } finally {
    await reader.close();
  }
});

it.each(["invalid", "cancelled"] as const)(
  "retries a first %s preparation without publishing its metadata",
  async (mode) => {
    const path = await fixture(buildVbmetaImageWithAllDescriptors());
    const controller = new AbortController();
    let refuse = true;
    class InterruptedPreparation extends AvbVbmetaArtifactReader {
      protected override async prepareEntries(signal?: AbortSignal) {
        const prepared = await super.prepareEntries(signal);
        if (refuse) {
          refuse = false;
          if (mode === "invalid")
            throw malformedArtifact(
              "avb-vbmeta-image",
              "injected preparation failure",
            );
          controller.abort(new Error("cancel final preparation validation"));
        }
        return prepared;
      }
    }
    const reader = new InterruptedPreparation(path);
    try {
      const onCoverage = vi.fn();
      await expect(
        (async () => {
          for await (const _entry of reader.entries(controller.signal, {
            onCoverage,
          })) {
            throw new Error("Failed preparation yielded an entry");
          }
        })(),
      ).rejects.toMatchObject({
        reason: mode === "invalid" ? "malformed" : "cancelled",
      });
      expect(onCoverage).not.toHaveBeenCalled();
      expect(reader.formatMetadata()).toBeUndefined();
      expect(await collectEntries(reader)).toHaveLength(5);
      expect(reader.formatMetadata()).toMatchObject({
        descriptor_count: 5,
      });
    } finally {
      await reader.close();
    }
  },
);

it("preserves cancellation during header admission", async () => {
  const path = await fixture(buildVbmetaImageWithAllDescriptors());
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AvbVbmetaArtifactReader(path, admitted);
  const controller = new AbortController();
  const reason = new Error("cancel header admission");
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  const reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
    ...args: unknown[]
  ) => {
    const result = await Reflect.apply(nativeRead, admitted.handle, args);
    if (args[3] === 0) controller.abort(reason);
    return result;
  }) as typeof admitted.handle.read);
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries(controller.signal)) {
          /* Exhaust the admitted operation. */
        }
      })(),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  } finally {
    await reader.close();
    reads.mockRestore();
    await admitted.handle.close();
  }
});

artifactReaderLifecycleCases({
  image: () => buildVbmetaImageWithAllDescriptors(),
  createReader: (path, admitted) => new AvbVbmetaArtifactReader(path, admitted),
});

it("rejects a source changed after its descriptors were prepared", async () => {
  const bytes = buildVbmetaImageWithAllDescriptors();
  const path = await fixture(bytes);
  const reader = new AvbVbmetaArtifactReader(path);
  try {
    const [entry] = await collectEntries(reader);
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
    await expect(reader.open(entry!)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});

it("rejects an excessive descriptor count before reading the table", async () => {
  const descriptors = Array.from({ length: 4097 }, (_, index) =>
    propertyDescriptor(`key-${String(index)}`, "v"),
  );
  const path = await fixture(buildVbmetaImage({ descriptors }));
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new AvbVbmetaArtifactReader(path, admitted);
  try {
    const failure: unknown = await collectEntries(reader).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      reason: "limit",
      boundary: "capacity",
      cause: {
        kind: "limit",
        failure: { limit: { maximum: 4096 } },
      },
    });
  } finally {
    await reader.close();
    await admitted.handle.close();
  }
});
