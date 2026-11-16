import { expect, it } from "vitest";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
} from "./ArtifactReader.js";

it("preserves an observed empty source key separately from missing or changed keys", () => {
  const entry: ArtifactEntry = {
    path: "__node_sea__/assets/0",
    sourcePath: "",
    kind: "file",
    declaredSize: 5,
    compressedSize: null,
    executable: false,
    encrypted: false,
    byteOffset: 64,
    declaredIntegrity: null,
    unpacked: false,
    limitations: [],
    adapterKey: "asset:0",
  };
  const copied = copyArtifactEntry(entry);
  expect(copied.sourcePath).toBe("");
  expect(sameArtifactEntry(copied, entry)).toBe(true);
  expect(sameArtifactEntry({ ...copied, sourcePath: "changed" }, entry)).toBe(
    false,
  );
  const { sourcePath: _sourcePath, ...withoutSource } = copied;
  expect(sameArtifactEntry(withoutSource, entry)).toBe(false);
});

it.each([
  undefined,
  null,
  "caller reason",
  new ArtifactReaderFailure("cancelled", "caller-provided error"),
])(
  "preserves explicit cancellation through repeated cleanup composition: %s",
  (reason) => {
    const primary = new ArtifactReaderFailure("cancelled", "Read cancelled", {
      cause: reason,
    });
    const first = ArtifactReaderFailure.withCleanup(primary, {
      reason: "first close failed",
      resources: ["first"],
    });
    const second = ArtifactReaderFailure.withCleanup(first, {
      reason: "second close failed",
      resources: ["second"],
    });
    expect(second.cancellation).toBe(primary.cancellation);
    expect(second.cancellation?.reason).toBe(reason);
    expect(second.cleanup?.resources).toEqual(["first", "second"]);
    expect(second.cause).toBe(first);
  },
);

it("requires an integrity failure to name its check, including when rebuilt", () => {
  // @ts-expect-error An integrity failure names the check that failed.
  void new ArtifactReaderFailure("integrity", "unnamed integrity failure");
  const primary = new ArtifactReaderFailure("integrity", "carrier changed", {
    integrityCheck: "container-identity",
  });
  const rebuilt = new ArtifactReaderFailure(primary.reason, primary.message, {
    cause: primary,
    ...primary.primaryFacts(),
  });
  expect(rebuilt.integrityCheck).toBe("container-identity");
  const reason: ArtifactReaderFailure["reason"] = primary.reason;
  // @ts-expect-error A rebuild with a non-literal reason carries the check.
  void new ArtifactReaderFailure(reason, "rebuilt without its check");
});
