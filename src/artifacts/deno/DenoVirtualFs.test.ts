import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  MAX_DENO_LOGICAL_PATH_BYTES,
  MAX_DENO_LOGICAL_PATH_PARTS,
  MAX_DENO_PATH_COMPONENT_BYTES,
  MAX_DENO_VFS_DEPTH,
  MAX_DENO_VFS_ENTRIES,
  MAX_DENO_VFS_NAME_UNITS,
  walkDenoVirtualFs,
} from "./DenoVirtualFs.js";

const file = (
  name: string,
  offset: number,
  length: number,
  extra: Record<string, unknown> = {},
) => ({ File: { n: name, o: [offset, length], ...extra } });

it("lists files, directories, symlinks, and child regions", () => {
  const walked = walkDenoVirtualFs(
    [
      {
        Dir: {
          n: "src",
          e: [
            file("main.ts", 0, 4, {
              m: [4, 3],
              c: [7, 2],
              s: [9, 1],
              u: true,
              x: true,
            }),
            { Symlink: { n: "link", p: ["..", "other"] } },
          ],
        },
      },
    ],
    10,
  );
  expect(walked.listing).toBe("listed");
  expect(walked.members.map((member) => [member.role, member.path])).toEqual([
    ["vfs-file", "src/main.ts"],
    ["vfs-transpiled", "src/main.ts.deno-transpiled"],
    ["vfs-cjs-export-analysis", "src/main.ts.deno-cjs-analysis"],
    ["vfs-source-map", "src/main.ts.deno-sourcemap"],
    ["vfs-symlink", "src/link"],
  ]);
  expect(walked.members[0]).toMatchObject({
    executable: true,
    isValidUtf8: true,
    offset: 0,
    length: 4,
  });
  expect(walked.members.at(-1)).toMatchObject({
    offset: null,
    length: null,
    symlinkDestParts: ["..", "other"],
  });
});

it("indexes unsafe and deep names and keeps duplicate names", () => {
  const unsafe = walkDenoVirtualFs([file("..", 0, 0), file("../etc", 0, 0)], 0);
  expect(unsafe.members.map((member) => member.path)).toEqual([
    "deno-vfs/0",
    "deno-vfs/1",
  ]);
  expect(unsafe.members[0]?.limitations[0]).toContain("safe relative path");
  expect(unsafe.members[0]?.sourcePath).toBe("..");

  const nest = (depth: number): unknown[] =>
    depth === 0
      ? [file("leaf.ts", 0, 0)]
      : [{ Dir: { n: "d", e: nest(depth - 1) } }];
  const deep = walkDenoVirtualFs(nest(MAX_DENO_LOGICAL_PATH_PARTS), 0);
  const leaf = deep.members.find((member) => member.role === "vfs-file");
  expect(leaf?.path.startsWith("deno-vfs/")).toBe(true);
  expect(leaf?.sourcePath?.endsWith("/leaf.ts")).toBe(true);

  const duplicates = walkDenoVirtualFs(
    [file("tree", 0, 1), file("tree", 1, 1)],
    2,
  );
  expect(duplicates.members.map((member) => member.path)).toEqual([
    "tree",
    "tree",
  ]);
});

it.each([false, true])(
  "reserves natural destinations before child regions (natural first: %s)",
  (naturalFirst) => {
    const original = file("main.ts", 0, 1, {
      m: [1, 1],
      c: [2, 1],
      s: [3, 1],
    });
    const natural = [
      file("main.ts.deno-transpiled", 4, 1),
      { Dir: { n: "main.ts.deno-cjs-analysis", e: [file("leaf", 5, 1)] } },
      { Symlink: { n: "main.ts.deno-sourcemap", p: ["main.ts"] } },
      file("deno-vfs", 6, 1),
    ];
    const walked = walkDenoVirtualFs(
      naturalFirst ? [...natural, original] : [original, ...natural],
      7,
    );
    const children = walked.members.filter((member) =>
      ["vfs-transpiled", "vfs-cjs-export-analysis", "vfs-source-map"].includes(
        member.role,
      ),
    );
    expect(children).toHaveLength(3);
    for (const [index, child] of children.entries()) {
      expect(child).toMatchObject({
        path: `deno-vfs-1/${String(naturalFirst ? 5 : 0)}.${child.role}`,
        sourcePath: "main.ts",
        offset: index + 1,
        length: 1,
        limitations: [expect.stringContaining("conflicts")],
      });
    }
    expect(
      walked.members.find((member) => member.path === "main.ts"),
    ).toMatchObject({ sourcePath: "main.ts", offset: 0 });
    expect(walked.members.map((member) => member.path)).toEqual(
      expect.arrayContaining([
        "main.ts.deno-transpiled",
        "main.ts.deno-cjs-analysis/leaf",
        "main.ts.deno-sourcemap",
        "deno-vfs",
      ]),
    );
  },
);

it("returns an unsupported listing for an untagged shape", () => {
  expect(walkDenoVirtualFs([{ nope: 1 }], 0)).toEqual({
    listing: "unsupported",
    members: [],
  });
  expect(walkDenoVirtualFs({ File: { n: "a", o: [0, 0] } }, 0)).toEqual({
    listing: "unsupported",
    members: [],
  });
});

it.each(["0", "0.deno-transpiled", "0/leaf"])(
  "keeps indexed files and child regions clear of the natural destination %s",
  (name) => {
    const source = "n".repeat(243);
    const natural = name.includes("/")
      ? { Dir: { n: "0", e: [file("leaf", 0, 0)] } }
      : file(name, 0, 0);
    const walked = walkDenoVirtualFs(
      [
        file(source, 0, 0, { m: [0, 0] }),
        { Dir: { n: "deno-vfs", e: [natural] } },
        file("deno-vfs-1", 0, 0),
      ],
      0,
    );
    expect(walked.members.slice(0, 2)).toMatchObject([
      { path: "deno-vfs-2/0", sourcePath: source },
      { path: "deno-vfs-2/0.deno-transpiled", sourcePath: source },
    ]);
    expect(walked.members[2]?.path).toBe(`deno-vfs/${name}`);
  },
);

it("refuses an entry count above the named allowance", () => {
  const entries = Array.from({ length: MAX_DENO_VFS_ENTRIES + 1 }, () =>
    file("a.ts", 0, 0),
  );
  expect(() => walkDenoVirtualFs(entries, 0)).toThrow(ArtifactReaderFailure);
  try {
    walkDenoVirtualFs(entries, 0);
  } catch (cause) {
    expect(cause).toMatchObject({ reason: "limit" });
  }
});

it("does not publish a bare child name when an ancestor source was dropped", () => {
  const long = "N".repeat(MAX_DENO_VFS_NAME_UNITS + 1);
  const walked = walkDenoVirtualFs(
    [
      {
        Dir: {
          n: "..",
          e: [
            {
              Dir: {
                n: long,
                e: [file("leaf.ts", 0, 0)],
              },
            },
          ],
        },
      },
    ],
    0,
  );
  const leaf = walked.members.find((member) => member.role === "vfs-file");
  expect(leaf?.sourcePath).toBeNull();
  expect(leaf?.sourcePath).not.toBe("leaf.ts");
  expect(JSON.stringify(walked)).not.toContain(long);

  const kept = walkDenoVirtualFs(
    [{ Dir: { n: "..", e: [file("leaf.ts", 0, 0)] } }],
    0,
  );
  expect(
    kept.members.find((member) => member.role === "vfs-file")?.sourcePath,
  ).toBe("../leaf.ts");
});

it("indexes an oversized directory name without retaining it for every child", () => {
  const name = "N".repeat(MAX_DENO_VFS_NAME_UNITS + 1);
  const children = Array.from({ length: 48 }, (_, index) =>
    file(`child-${String(index)}.ts`, 0, 0),
  );
  const walked = walkDenoVirtualFs([{ Dir: { n: name, e: children } }], 0);
  expect(walked.listing).toBe("listed");
  expect(walked.members).toHaveLength(children.length);
  const serialized = JSON.stringify(walked);
  expect(serialized).not.toContain(name);
  expect(serialized.length).toBeLessThan(name.length * children.length);
  expect(walked.members.every((member) => member.sourcePath === null)).toBe(
    true,
  );
  expect(
    walked.members.every((member) =>
      member.limitations.some((limitation) =>
        limitation.includes(`${String(MAX_DENO_VFS_NAME_UNITS)}-unit`),
      ),
    ),
  ).toBe(true);
});

it("refuses nesting past the depth allowance with a tagged limit", () => {
  const nest = (depth: number): unknown[] =>
    depth === 0
      ? [file("leaf.ts", 0, 0)]
      : [{ Dir: { n: "d", e: nest(depth - 1) } }];
  expect(() => walkDenoVirtualFs(nest(MAX_DENO_VFS_DEPTH), 0)).toThrow(
    ArtifactReaderFailure,
  );
  try {
    walkDenoVirtualFs(nest(MAX_DENO_VFS_DEPTH), 0);
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArtifactReaderFailure);
    expect(cause).toMatchObject({
      reason: "limit",
      message: expect.stringContaining("MAX_DENO_VFS_DEPTH"),
    });
  }
});

it("refuses a virtual filesystem walk that is already cancelled", () => {
  const signal = AbortSignal.abort();
  expect(() => walkDenoVirtualFs([file("main.ts", 0, 0)], 0, signal)).toThrow(
    ArtifactReaderFailure,
  );
  try {
    walkDenoVirtualFs([file("main.ts", 0, 0)], 0, signal);
  } catch (cause) {
    expect(cause).toMatchObject({ reason: "cancelled" });
  }
});

it("rejects a region that overruns vfs file data", () => {
  expect(() => walkDenoVirtualFs([file("main.ts", 0, 4)], 1)).toThrow(
    ArtifactReaderFailure,
  );
  try {
    walkDenoVirtualFs([file("main.ts", 0, 4)], 1);
  } catch (cause) {
    expect(cause).toMatchObject({
      reason: "format",
      message: expect.stringContaining("overruns"),
    });
  }
});

it("indexes a name over the component byte limit and keeps its spelling", () => {
  const name = "\u20ac".repeat(86);
  expect(name.length).toBeLessThan(MAX_DENO_VFS_NAME_UNITS);
  expect(Buffer.byteLength(name)).toBeGreaterThan(
    MAX_DENO_PATH_COMPONENT_BYTES,
  );
  const walked = walkDenoVirtualFs(
    [{ Dir: { n: name, e: [file("leaf.ts", 0, 0)] } }, file(name, 0, 0)],
    0,
  );
  expect(walked.members.map((member) => member.path)).toEqual([
    "deno-vfs/1",
    "deno-vfs/2",
  ]);
  expect(walked.members[0]).toMatchObject({
    sourcePath: `${name}/leaf.ts`,
    limitations: [
      expect.stringContaining(`${String(MAX_DENO_PATH_COMPONENT_BYTES)}-byte`),
    ],
  });
  expect(walked.members[1]?.sourcePath).toBe(name);
});

it("reserves component bytes for the child regions a file actually has", () => {
  const name = "n".repeat(MAX_DENO_PATH_COMPONENT_BYTES);
  expect(walkDenoVirtualFs([file(name, 0, 0)], 0).members[0]?.path).toBe(name);
  for (const key of ["m", "c", "s"]) {
    const walked = walkDenoVirtualFs([file(name, 0, 0, { [key]: [0, 0] })], 0);
    expect(walked.members[0]?.path).toBe("deno-vfs/0");
    expect(walked.members[1]?.path.startsWith("deno-vfs/0.deno-")).toBe(true);
    expect(walked.members[0]?.sourcePath).toBe(name);
  }
  const short = "n".repeat(MAX_DENO_PATH_COMPONENT_BYTES - 16);
  expect(
    walkDenoVirtualFs([file(short, 0, 0, { m: [0, 0] })], 0).members[1]?.path,
  ).toBe(`${short}.deno-transpiled`);
});

it("indexes a path over the logical byte allowance and its descendants", () => {
  const part = "p".repeat(200);
  const walked = walkDenoVirtualFs(
    [
      {
        Dir: {
          n: part,
          e: [
            {
              Dir: { n: part, e: [{ Dir: { n: part, e: [file("x", 0, 0)] } }] },
            },
          ],
        },
      },
    ],
    0,
  );
  expect(walked.members[0]).toMatchObject({
    path: "deno-vfs/3",
    sourcePath: `${part}/${part}/${part}/x`,
    limitations: [
      expect.stringContaining(`${String(MAX_DENO_LOGICAL_PATH_BYTES)}-byte`),
    ],
  });
});

it("charges directory paths against the retained allowance", () => {
  const name = "d".repeat(MAX_DENO_VFS_NAME_UNITS);
  const emptySiblings = Array.from({ length: 99_000 }, (_, index): unknown => ({
    Dir: { n: `s${String(index)}`, e: [] },
  }));
  const chain = (depth: number): unknown[] =>
    depth === 0 ? emptySiblings : [{ Dir: { n: name, e: chain(depth - 1) } }];
  const started = performance.now();
  expect(() =>
    walkDenoVirtualFs(chain(MAX_DENO_LOGICAL_PATH_PARTS), 0),
  ).toThrow(
    expect.objectContaining({
      reason: "limit",
      message: expect.stringContaining("MAX_DENO_VFS_RETAINED_UNITS"),
    }),
  );
  expect(performance.now() - started).toBeLessThan(5_000);
});
