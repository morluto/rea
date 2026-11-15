import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type {
  ArtifactEntry,
  ArtifactReader,
  ArtifactReaderTraversal,
} from "./ArtifactReader.js";
import { ArtifactTraversalObservation } from "./ArtifactTraversalObservation.js";

const entry = (path: string): ArtifactEntry => ({
  path,
  kind: "file",
  declaredSize: 1,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: null,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [],
  adapterKey: path,
});

/** A reader listing two members that declares `coverage`, or nothing. */
const reader = (
  format: ArtifactReader["format"],
  coverage: ArtifactReaderTraversal | undefined,
): ArtifactReader => ({
  format,
  async *entries(_signal, options) {
    yield entry("a");
    yield entry("b");
    if (coverage !== undefined) options?.onCoverage?.(coverage);
  },
  open: async () => Readable.from([]),
  provenance: () => [],
  async close() {},
});

const complete = { status: "complete", limitations: [] } as const;

const drain = async (iterable: AsyncIterable<ArtifactEntry>) => {
  const paths: string[] = [];
  for await (const item of iterable) paths.push(item.path);
  return paths;
};

describe("ArtifactTraversalObservation", () => {
  it("is complete only when the reader declares complete coverage and finishes", async () => {
    const traversal = new ArtifactTraversalObservation();
    expect(
      await drain(traversal.entries(reader("zip", complete), undefined)),
    ).toEqual(["a", "b"]);
    expect(traversal.snapshot()).toEqual(complete);
  });

  it("reports a reader that ends without declaring coverage as unknown", async () => {
    const traversal = new ArtifactTraversalObservation();
    await drain(traversal.entries(reader("ines", undefined), undefined));
    expect(traversal.snapshot()).toEqual({
      status: "unknown",
      limitations: [
        "The ines reader ended its traversal without declaring coverage; members it did not list are unknown.",
      ],
    });
  });

  it("does not let one declared-complete traversal cover a silent one", async () => {
    const traversal = new ArtifactTraversalObservation();
    await drain(traversal.entries(reader("directory", complete), undefined));
    await drain(traversal.entries(reader("asar", undefined), undefined));
    await drain(traversal.entries(reader("zip", complete), undefined));
    expect(traversal.snapshot()).toEqual({
      status: "unknown",
      limitations: [
        "The asar reader ended its traversal without declaring coverage; members it did not list are unknown.",
      ],
    });
  });

  it("reports a traversal its consumer stopped as unknown even after a declaration", async () => {
    const traversal = new ArtifactTraversalObservation();
    const early: ArtifactReader = {
      ...reader("zip", undefined),
      async *entries(_signal, options) {
        options?.onCoverage?.(complete);
        yield entry("a");
        yield entry("b");
      },
    };
    for await (const item of traversal.entries(early, undefined))
      if (item.path === "a") break;
    expect(traversal.snapshot()).toEqual({
      status: "unknown",
      limitations: [
        "The zip traversal stopped before the reader finished; members after the last listed entry are unknown.",
      ],
    });
  });

  it("leaves a failed traversal's result to its failure", async () => {
    const traversal = new ArtifactTraversalObservation();
    const failure = new Error("damaged");
    const failing: ArtifactReader = {
      ...reader("zip", undefined),
      async *entries() {
        throw failure;
      },
    };
    await expect(drain(traversal.entries(failing, undefined))).rejects.toBe(
      failure,
    );
    expect(traversal.snapshot()).toEqual(complete);
  });

  it("keeps a declared unknown coverage and its limitations", async () => {
    const traversal = new ArtifactTraversalObservation();
    await drain(
      traversal.entries(
        reader("wxapkg", { status: "unknown", limitations: ["encrypted"] }),
        undefined,
      ),
    );
    expect(traversal.snapshot()).toEqual({
      status: "unknown",
      limitations: ["encrypted"],
    });
  });
});
