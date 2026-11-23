import { describe, expect, it } from "vitest";
import type {
  ArtifactReader,
  ArtifactReaderTraversal,
  ArtifactTraversalSink,
} from "../resources/ArtifactReader.js";
import { ArtifactTraversalObservation } from "./ArtifactTraversalObservation.js";

const reader = (
  format: ArtifactReader["format"],
  coverage?: ArtifactReaderTraversal,
) => ({
  format,
  async *entries(
    _signal: AbortSignal | undefined,
    options: ArtifactTraversalSink,
  ) {
    yield "a";
    yield "b";
    if (coverage !== undefined) options.onCoverage(coverage);
  },
});

const collect = async (source: AsyncIterable<string>): Promise<string[]> => {
  const paths: string[] = [];
  for await (const path of source) paths.push(path);
  return paths;
};

const complete = { status: "complete", limitations: [] } as const;

describe("ArtifactTraversalObservation", () => {
  it("does not let one declared-complete traversal cover a silent one", async () => {
    const traversal = new ArtifactTraversalObservation();
    expect(
      await collect(
        traversal.entries(reader("directory", complete), undefined),
      ),
    ).toEqual(["a", "b"]);
    expect(traversal.snapshot()).toEqual(complete);

    await collect(traversal.entries(reader("asar"), undefined));
    await collect(traversal.entries(reader("zip", complete), undefined));
    expect(traversal.snapshot()).toEqual({
      status: "unknown",
      limitations: [
        "The asar reader ended its traversal without declaring coverage; members it did not list are unknown.",
      ],
    });
  });

  it("reports a traversal its consumer stopped as unknown even after a declaration", async () => {
    const traversal = new ArtifactTraversalObservation();
    let returned = false;
    const early = {
      format: "zip" as const,
      async *entries(
        _signal: AbortSignal | undefined,
        options: ArtifactTraversalSink,
      ) {
        try {
          options.onCoverage(complete);
          yield "a";
          yield "b";
        } finally {
          returned = true;
        }
      },
    };
    for await (const item of traversal.entries(early, undefined))
      if (item === "a") break;
    expect(returned).toBe(true);
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
    const failing = {
      format: "zip" as const,
      async *entries() {
        throw failure;
      },
    };
    const iterator = traversal.entries(failing, undefined);
    await expect(iterator.next()).rejects.toBe(failure);
    await iterator.return?.();
    expect(traversal.snapshot()).toEqual(complete);
  });

  it("keeps a declared unknown coverage and its limitations", async () => {
    const traversal = new ArtifactTraversalObservation();
    await collect(
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
