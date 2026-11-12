import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  entrypointSpellingVerdict,
  isNetworkSharePath,
  sameEntrypointSpelling,
  selectEntrypoint,
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
  // A share spelling is a Windows concept: on POSIX `//tmp/x` is a local absolute path.
  it.each([["\\\\server\\share\\rea.mjs"], ["//server/share/rea.mjs"]])(
    "recognizes a network share spelling on Windows: %s",
    (candidate) => {
      expect(isNetworkSharePath(candidate)).toBe(process.platform === "win32");
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

  it("refuses to answer for a share it never read", () => {
    // A share is never dereferenced, so its lexical form is not evidence of identity: the same
    // spelling can be remounted, and two different ones can name the same file after a retarget.
    const { read, resolveSpelling } = recordingResolver();
    expect(
      entrypointSpellingVerdict(
        "\\\\server\\share\\rea.mjs",
        "\\\\server\\share\\other.mjs",
        "node",
        resolveSpelling,
      ),
    ).toBe("unknown");
    expect(read).toEqual([]);
  });

  it("refuses to answer for two equal shares too", () => {
    const { read, resolveSpelling } = recordingResolver();
    expect(
      entrypointSpellingVerdict(
        "\\\\server\\share\\rea.mjs",
        "\\\\server\\share\\rea.mjs",
        "node",
        resolveSpelling,
      ),
    ).toBe("unknown");
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

it("normalizes a parent segment before resolving it", () => {
  // The launcher normalizes lexically *first*, then follows whatever the normalized path
  // selects. Measured on Node 24.22.1: with `a/link` pointing at `b/deep` and both `a/s.mjs`
  // and `b/s.mjs` present, `node a/link/../s.mjs` runs `a/s.mjs`, not `b/s.mjs`.
  const { read, resolveSpelling } = recordingResolver();
  selectedFile("/root/a/link/../s.mjs", resolveSpelling);
  // The resolver sees the normalized spelling, never the raw one.
  expect(read).toEqual([resolve("/root/a/link/../s.mjs")]);
  expect(read[0]).not.toContain("link");
});

it("still decides two equal spellings by what they select", () => {
  // Equality alone is not alignment: a manager alias can be retargeted while the process runs.
  const { read, resolveSpelling } = recordingResolver();
  expect(
    sameEntrypointSpelling(
      "/root/rea.mjs",
      "/root/rea.mjs",
      process.platform === "win32" ? "node" : "node",
      resolveSpelling,
    ),
  ).toBe(true);
  expect(read).toEqual(["/root/rea.mjs", "/root/rea.mjs"]);
});

it.each([
  // A Windows device spelling names a local volume, so it is not a share and reading it touches
  // no network. Only the `UNC` device form reaches a share.
  ["\\\\?\\C:\\release\\rea.mjs"],
  ["\\\\.\\C:\\release\\rea.mjs"],
  ["\\\\.\\pipe\\rea"],
])(
  "keeps a Windows device spelling out of the share guard: %s",
  (candidate) => {
    expect(isNetworkSharePath(candidate)).toBe(false);
  },
);

it.each([
  ["\\\\?\\UNC\\server\\share\\rea.mjs"],
  ["\\\\.\\UNC\\server\\share\\rea.mjs"],
])("still recognizes the UNC device form as a share: %s", (candidate) => {
  expect(isNetworkSharePath(candidate)).toBe(process.platform === "win32");
});

it.skipIf(process.platform === "win32")(
  "keeps the traversal Bun performed in the snapshot",
  () => {
    // Bun follows the link before `..` while Node normalizes lexically, so a Bun launcher is
    // resolved without the lexical step.
    const { read, resolveSpelling } = recordingResolver();
    selectEntrypoint("/root/a/link/../s.mjs", resolveSpelling, "bun");
    expect(read).toEqual(["/root/a/link/../s.mjs"]);
  },
);
