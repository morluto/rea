import { setImmediate } from "node:timers/promises";

import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  NODE_SEA_MAGIC,
  decodeNodeSeaBlob,
  observeNodeSeaFuseMatches,
} from "./NodeSeaBlob.js";
import { buildNodeSeaBlob } from "./NodeSea.fixture.js";

const header = (flags: number, extension = 1): Buffer => {
  const bytes = Buffer.alloc(9);
  bytes.writeUInt32LE(NODE_SEA_MAGIC, 0);
  bytes.writeUInt32LE(flags, 4);
  bytes[8] = extension;
  return bytes;
};

it("rejects a blob that ends before the magic", async () => {
  await expect(
    decodeNodeSeaBlob(Buffer.from([0x20, 0xda])),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/Node SEA.*truncated/iu),
  });
});

it("rejects a blob whose magic is not 0x143da20", async () => {
  await expect(decodeNodeSeaBlob(Buffer.alloc(9))).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/magic.*not.*0x143da20/iu),
  });
});

it("rejects a header that ends before the extension byte", async () => {
  await expect(
    decodeNodeSeaBlob(header(0).subarray(0, 8)),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/Node SEA.*truncated/iu),
  });
});

it("rejects unknown flag bits", async () => {
  await expect(decodeNodeSeaBlob(header(1 << 5))).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/flags.*unknown bits/iu),
  });
});

it("rejects an unknown exec argv extension", async () => {
  await expect(decodeNodeSeaBlob(header(0, 9))).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/exec argv extension.*unknown/iu),
  });
});

it("rejects an empty code path", async () => {
  await expect(
    decodeNodeSeaBlob(buildNodeSeaBlob({ codePath: "" })),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/code path.*empty/iu),
  });
});

it("rejects a truncated length-prefixed field", async () => {
  const bytes = Buffer.concat([header(0), Buffer.alloc(4)]);
  await expect(decodeNodeSeaBlob(bytes)).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/Node SEA.*truncated/iu),
  });
});

it("rejects colliding asset names", async () => {
  await expect(
    decodeNodeSeaBlob(
      buildNodeSeaBlob({
        assets: [
          { name: "shared", body: "one" },
          { name: "shared", body: "two" },
        ],
      }),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/Node SEA asset name collides.*shared/iu),
  });
});

it("retains an empty asset key as a raw Node SEA key", async () => {
  const decoded = await decodeNodeSeaBlob(
    buildNodeSeaBlob({ assets: [{ name: "", body: "value" }] }),
  );
  expect(decoded.assets).toMatchObject([{ name: "", range: { length: 5 } }]);
});

it.each([
  {
    field: "code path",
    build: (value: string) => buildNodeSeaBlob({ codePath: value }),
    read: (blob: Awaited<ReturnType<typeof decodeNodeSeaBlob>>) =>
      blob.codePath,
  },
  {
    field: "asset name",
    build: (value: string) =>
      buildNodeSeaBlob({ assets: [{ name: value, body: "" }] }),
    read: (blob: Awaited<ReturnType<typeof decodeNodeSeaBlob>>) =>
      blob.assets[0]?.name,
  },
  {
    field: "exec argument",
    build: (value: string) => buildNodeSeaBlob({ execArgv: [value] }),
    read: (blob: Awaited<ReturnType<typeof decodeNodeSeaBlob>>) =>
      blob.execArgv[0],
  },
])(
  "rejects invalid UTF-8 in $field while preserving a literal replacement character",
  async ({ build, read }) => {
    const valid = await decodeNodeSeaBlob(build("\ufffd"));
    expect(read(valid)).toBe("\ufffd");

    const malformed = build("fixture-marker");
    const offset = malformed.indexOf("fixture-marker");
    expect(offset).toBeGreaterThanOrEqual(0);
    malformed[offset] = 0xff;
    await expect(decodeNodeSeaBlob(malformed)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(/not valid UTF-8/iu),
    });
  },
);

const limitOf = async (bytes: Buffer): Promise<ArtifactReaderFailure> => {
  try {
    await decodeNodeSeaBlob(bytes);
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure) return cause;
    throw cause;
  }
  throw new Error("expected a limit failure");
};

it("refuses an asset table over its count bound before creating records", async () => {
  const assets = Array.from({ length: 100_001 }, (_, index) => ({
    name: `asset-${String(index)}`,
    body: "",
  }));
  const failure = await limitOf(buildNodeSeaBlob({ assets }));
  expect(failure).toMatchObject({
    reason: "limit",
    message: expect.stringMatching(
      /asset count.*100000.*no runtime override/iu,
    ),
  });
});

it("refuses asset names over the decoded name budget", async () => {
  const name = "n".repeat(4 * 1024 * 1024 + 1);
  const failure = await limitOf(
    buildNodeSeaBlob({
      assets: [
        { name: `a${name}`, body: "" },
        { name: `b${name}`, body: "" },
      ],
    }),
  );
  expect(failure).toMatchObject({
    reason: "limit",
    message: expect.stringMatching(
      /asset names.*8388608.*no runtime override/iu,
    ),
  });
});

it.each([
  {
    label: "count",
    accepted: () => Array.from({ length: 4096 }, () => "x"),
    args: () => Array.from({ length: 4097 }, () => "x"),
    boundary: "capacity",
    warning: /exec argv count.*4096.*no runtime override/iu,
  },
  {
    label: "text",
    accepted: () => ["x".repeat(1024 * 1024)],
    args: () => ["x".repeat(1024 * 1024 + 1)],
    boundary: "memory",
    warning: /exec argv text.*1048576.*no runtime override/iu,
  },
])(
  "admits exec argument $label at its bound and refuses more",
  async ({ accepted, args, boundary, warning }) => {
    const atLimit = accepted();
    expect(
      (await decodeNodeSeaBlob(buildNodeSeaBlob({ execArgv: atLimit })))
        .execArgv,
    ).toEqual(atLimit);
    const failure = await limitOf(buildNodeSeaBlob({ execArgv: args() }));
    expect(failure).toMatchObject({
      reason: "limit",
      boundary,
      message: expect.stringMatching(warning),
    });
  },
);

it("rejects non-zero trailing bytes and keeps zero padding", async () => {
  const padded = buildNodeSeaBlob({ trailing: Buffer.alloc(8) });
  expect((await decodeNodeSeaBlob(padded)).codePath).toBe("sea.js");
  const dirty = Buffer.concat([padded, Buffer.from([1])]);
  await expect(decodeNodeSeaBlob(dirty)).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/trailing bytes/iu),
  });
});

it("decodes flags, the main script, code cache, assets, and exec argv", async () => {
  const decoded = await decodeNodeSeaBlob(
    buildNodeSeaBlob({
      codePath: "app/main.js",
      main: "console.log(1)\n",
      codeCache: Buffer.from([1, 2, 3]),
      assets: [{ name: "pkg/data.txt", body: "asset" }],
      execArgv: ["--no-warnings", ""],
      disableExperimentalSeaWarning: true,
      execArgvExtension: 2,
    }),
  );
  expect(decoded).toMatchObject({
    flags: (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4),
    disableExperimentalSeaWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    includeAssets: true,
    includeExecArgv: true,
    execArgvExtension: "cli",
    codePath: "app/main.js",
    execArgv: ["--no-warnings", ""],
    assets: [{ name: "pkg/data.txt" }],
  });
  expect(decoded.mainScript?.length).toBe(
    Buffer.byteLength("console.log(1)\n"),
  );
  expect(decoded.snapshot).toBeNull();
  expect(decoded.codeCache?.length).toBe(3);
});

it("treats the body as a snapshot when that flag is set", async () => {
  const decoded = await decodeNodeSeaBlob(
    buildNodeSeaBlob({
      codePath: "sea.js",
      snapshot: Buffer.from("snap"),
    }),
  );
  expect(decoded.useSnapshot).toBe(true);
  expect(decoded.mainScript).toBeNull();
  expect(decoded.snapshot?.length).toBe(4);
});

it("reports an absent, unset, set, or conflicting fuse sentinel", () => {
  expect(observeNodeSeaFuseMatches([])).toMatchObject({
    fuseState: "absent",
    fuseSentinel: null,
    fuseContradiction: expect.stringMatching(
      /no NODE_SEA_FUSE sentinel.*observed/iu,
    ),
  });
  const unset = `NODE_SEA_FUSE_${"a".repeat(32)}:0`;
  expect(observeNodeSeaFuseMatches([unset, unset])).toMatchObject({
    fuseState: "unset",
    fuseSentinel: unset,
    fuseContradiction: expect.stringMatching(/NODE_SEA_FUSE sentinel.*unset/iu),
  });
  const set = `NODE_SEA_FUSE_${"b".repeat(32)}:1`;
  expect(observeNodeSeaFuseMatches([set])).toMatchObject({
    fuseState: "set",
    fuseSentinel: set,
    fuseContradiction: null,
  });
  expect(observeNodeSeaFuseMatches([unset, set])).toMatchObject({
    fuseState: "conflicting",
    fuseSentinel: null,
    fuseContradiction: expect.stringMatching(/fuse sentinels disagree/iu),
  });
});

it.each([
  [
    "assets",
    () =>
      buildNodeSeaBlob({
        assets: Array.from({ length: 1024 }, (_, index) => ({
          name: `asset-${String(index)}`,
          body: "",
        })),
      }),
  ],
  [
    "exec arguments",
    () =>
      buildNodeSeaBlob({
        execArgv: Array.from({ length: 1024 }, () => "--no-warnings"),
      }),
  ],
  [
    "zero padding",
    () => buildNodeSeaBlob({ trailing: Buffer.alloc(1024 * 1024) }),
  ],
] as const)("observes cancellation while decoding %s", async (_name, build) => {
  const bytes = build();
  const controller = new AbortController();
  const reason = { stage: "decoding" };
  const pending = decodeNodeSeaBlob(bytes, controller.signal);
  // Let a batch run; cancellation must be observed before the whole table or
  // padding scan finishes, without relying on elapsed-time assertions.
  await setImmediate();
  controller.abort(reason);
  await expect(pending).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
});

it("preserves cancellation before decoding even a malformed blob", async () => {
  const reason = { stage: "before decoding" };
  await expect(
    decodeNodeSeaBlob(Buffer.alloc(0), AbortSignal.abort(reason)),
  ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
});
