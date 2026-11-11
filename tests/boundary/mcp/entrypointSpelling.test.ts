import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isNetworkSharePath,
  sameEntrypointSpelling,
  selectedFile,
  traversalSemanticsDiffer,
} from "../../../src/process/EntrypointSpelling.js";

/**
 * The spelling rules guard comparisons against caller-supplied text. The resolver is injected so
 * a test can observe whether the filesystem was consulted at all — the answer does not always
 * differ, because a failed read falls back to the lexical path.
 */
const recordingResolver = () => {
  const read: string[] = [];
  const resolveSpelling = (candidate: string): string => {
    read.push(candidate);
    return candidate;
  };
  return { read, resolveSpelling };
};

describe("entrypoint spelling rules", () => {
  it.each([["\\\\server\\share\\rea.mjs"], ["//server/share/rea.mjs"]])(
    "recognizes a network share spelling: %s",
    (candidate) => {
      expect(isNetworkSharePath(candidate)).toBe(true);
    },
  );

  it.each([
    ["C:\\rea\\rea.mjs"],
    ["/opt/rea/rea.mjs"],
    // A single separator is a rooted local path, not a share.
    ["\\rea\\rea.mjs"],
    ["rea.mjs"],
  ])("does not treat a local spelling as a share: %s", (candidate) => {
    expect(isNetworkSharePath(candidate)).toBe(false);
  });

  it("never reads a network share", () => {
    // Reading one starts SMB traffic and can block on ambient Windows authentication, so the
    // resolver must not be called at all.
    const { read, resolveSpelling } = recordingResolver();
    expect(selectedFile("\\\\server\\share\\rea.mjs", resolveSpelling)).toBe(
      "\\\\server\\share\\rea.mjs",
    );
    expect(read).toEqual([]);
  });

  it.each([["\\\\server\\share\\rea.mjs"], ["//server/share/rea.mjs"]])(
    "keeps a share spelling absolute off Windows: %s",
    (candidate) => {
      // `resolve` would prepend the working directory to this spelling on a POSIX host, where it
      // is not absolute, so the lexical form has to use Windows semantics. Both spellings name
      // the same share, so they also have to produce one form.
      expect(selectedFile(candidate)).toBe("\\\\server\\share\\rea.mjs");
    },
  );

  it("reads a local spelling once", () => {
    const { read, resolveSpelling } = recordingResolver();
    selectedFile("/opt/rea/rea.mjs", resolveSpelling);
    expect(read).toEqual(["/opt/rea/rea.mjs"]);
  });

  it("keeps two different shares apart without reading them", () => {
    const { read, resolveSpelling } = recordingResolver();
    expect(
      sameEntrypointSpelling(
        "\\\\server\\share\\rea.mjs",
        "\\\\server\\share\\other.mjs",
        "node",
        resolveSpelling,
      ),
    ).toBe(false);
    expect(read).toEqual([]);
  });

  it("falls back to the lexical path when the read fails", () => {
    const failing = () => {
      throw new Error("ENOENT");
    };
    // The fallback is `resolve`, so compare against it rather than the raw spelling.
    expect(selectedFile("/opt/rea/rea.mjs", failing)).toBe(
      resolve("/opt/rea/rea.mjs"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "treats a parent segment under Bun as undecidable",
    () => {
      // Bun follows the link before `..` while realpath normalizes lexically, so the two
      // spellings cannot be compared; `true` means "not provably different".
      expect(traversalSemanticsDiffer("/root/link/../rea.mjs", "bun")).toBe(
        true,
      );
      const { read, resolveSpelling } = recordingResolver();
      expect(
        sameEntrypointSpelling(
          "/root/link/../rea.mjs",
          "/root/rea.mjs",
          "bun",
          resolveSpelling,
        ),
      ).toBe(true);
      expect(read).toEqual([]);
    },
  );

  it("does not apply the Bun rule to Node", () => {
    expect(traversalSemanticsDiffer("/root/link/../rea.mjs", "node")).toBe(
      false,
    );
  });
});
