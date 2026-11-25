import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  AXML_MANIFEST_EVENTS,
  buildAxml,
  type AxmlEvent,
} from "../../tests/fixtures/axml.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "../resources/ArtifactReader.js";
import { AxmlArtifactReader } from "./AxmlArtifactReader.js";

const writeDocument = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-axml-boundary-"),
    "AndroidManifest.xml",
  );
  await writeFile(path, bytes);
  return path;
};

const list = async (
  reader: AxmlArtifactReader,
  options?: ArtifactTraversalOptions,
): Promise<ArtifactEntry[]> => {
  const entries: ArtifactEntry[] = [];
  for await (const entry of reader.entries(undefined, options))
    entries.push(entry);
  return entries;
};

const withReader = async <T>(
  bytes: Buffer,
  use: (reader: AxmlArtifactReader) => Promise<T>,
): Promise<T> => {
  const reader = new AxmlArtifactReader(await writeDocument(bytes));
  try {
    return await use(reader);
  } finally {
    await reader.close();
  }
};

describe("axml decoder limits", () => {
  it("fails closed on an over-limit string count", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    // stringCount is the first u32 of the string-pool chunk at offset 16.
    bytes.writeUInt32LE(0x40001, 16);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed on over-limit element depth", async () => {
    const depth = 4097;
    const events: AxmlEvent[] = [];
    for (let i = 0; i < depth; i++)
      events.push({ kind: "start", name: `n${i}` });
    for (let i = depth - 1; i >= 0; i--)
      events.push({ kind: "end", name: `n${i}` });
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed when expanded attributes exceed the output bound", async () => {
    const big = "x".repeat(1024 * 1024);
    const attrs = Array.from({ length: 40 }, (_, i) => ({
      name: `a${i}`,
      value: big,
    }));
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "e", attrs },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed when one attribute's escaped expansion exceeds the bound", async () => {
    // 7 MiB of '&' is small raw but expands past the 32 MiB output bound
    // once escaped to '&amp;'; the budget must count the expansion.
    const attrs = [{ name: "a", value: "&".repeat(7 * 1024 * 1024) }];
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "e", attrs },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("fails closed when retained UTF-16 strings exceed the byte bound", async () => {
    // 129 distinct 65,500-unit CJK strings total ~8.45M code units, which
    // would pass a code-unit reading of the bound, but occupy ~16.9 MB as
    // retained UTF-16 and must trip the byte ceiling.
    const value = (i: number) => "一".repeat(65490) + String(i);
    const attrs = Array.from({ length: 129 }, (_, i) => ({
      name: `a${i}`,
      value: value(i),
    }));
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "e", attrs },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
        boundary: "capacity",
      });
    });
  });

  it("accepts retained UTF-16 strings just below the byte bound", async () => {
    // 127 strings of the same shape occupy ~16.6 MB as UTF-16, under the
    // 16 MiB ceiling, so the document decodes normally.
    const value = (i: number) => "一".repeat(65490) + String(i);
    const attrs = Array.from({ length: 127 }, (_, i) => ({
      name: `a${i}`,
      value: value(i),
    }));
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "e", attrs },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const entries = await list(reader);
      expect(entries.length).toBe(1);
    });
  });

  it("fails closed on an over-limit declared file", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS, {
      declaredSize: 64 * 1024 * 1024 + 1,
    });
    // A padded carrier larger than the bound refuses before parsing.
    const padded = Buffer.alloc(64 * 1024 * 1024 + 1);
    bytes.copy(padded, 0);
    await withReader(padded, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({
        reason: "limit",
      });
    });
  });
});

describe("axml malformed extents", () => {
  it("rejects attribute records extending past the chunk end", async () => {
    const bytes = buildAxml([
      {
        kind: "start",
        name: "manifest",
        attrs: [{ name: "package", value: "com.example" }],
      },
      { kind: "end", name: "manifest" },
    ]);
    // attrCount sits at +12 inside the start-element ext (chunk+28); the pool
    // chunk size is declared at offset 12 and the element chunk follows it.
    const startElement = 8 + bytes.readUInt32LE(12);
    bytes.writeUInt16LE(0xffff, startElement + 28);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a string offset outside the string data", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    // First string offset lives at pool base + 28; push it past the pool end.
    bytes.writeUInt32LE(0x7fffffff, 8 + 28);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a chunk extending past the declared document", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS, {
      declaredSize: 8 + 16,
    });
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a second root element", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "a" },
      { kind: "end", name: "a" },
      { kind: "start", name: "b" },
      { kind: "end", name: "b" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a document without a root element", async () => {
    await withReader(buildAxml([]), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a style-offset table overlapping string data", async () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    // styleCount is the pool header's third u32, at file offset 20.
    bytes.writeUInt32LE(1, 20);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a cdata chunk missing its value extension", async () => {
    // A 20-byte cdata node holds only the data index, not the Res_value.
    const cdata = Buffer.alloc(20);
    cdata.writeUInt16LE(0x0104, 0);
    cdata.writeUInt16LE(16, 2);
    cdata.writeUInt32LE(20, 4);
    cdata.writeUInt32LE(1, 8);
    cdata.writeUInt32LE(0xffffffff, 12);
    cdata.writeUInt32LE(0, 16);
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "a" },
      { kind: "end", name: "a" },
    ];
    await withReader(
      buildAxml(events, { tailChunks: [cdata] }),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });

  it("ignores resource map entries beyond the string pool", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "activity",
        attrs: [{ name: "name", value: ".Main" }],
      },
      { kind: "end", name: "activity" },
    ];
    const bytes = buildAxml(events, {
      resourceIds: { name: 0x01010003 },
      resourceMapExtra: 4,
    });
    await withReader(bytes, async (reader) => {
      let coverage:
        | { status: string; limitations: readonly string[] }
        | undefined;
      const entries = await list(reader, {
        onCoverage: (c) => {
          coverage = c;
        },
      });
      expect(entries.length).toBe(1);
      expect(coverage?.limitations.join(" ")).toContain(
        "beyond the string pool; they were ignored",
      );
    });
  });
});

describe("axml projection fidelity regressions", () => {
  it("rejects an end element whose namespace differs from the open element", async () => {
    // The end record reuses the name index but names a different namespace.
    const bytes = buildAxml([
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      { kind: "start", name: "e", ns: "urn:a" },
      { kind: "end", name: "e" },
      { kind: "endNs", prefix: "p", uri: "urn:a" },
    ]);
    // Pool layout: prefix, uri, name; the end-element chunk is the third
    // node record. Find it by walking declared chunk sizes.
    let cursor = 8 + bytes.readUInt32LE(12);
    cursor += bytes.readUInt32LE(cursor + 4); // start-ns
    cursor += bytes.readUInt32LE(cursor + 4); // start-element
    // End-element node: namespace index at +16, name index at +20.
    bytes.writeUInt32LE(0xffffffff, cursor + 16);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects names that are not XML NCNames", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "not a name" },
      { kind: "end", name: "not a name" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects a document ending with an open namespace scope", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      { kind: "start", name: "root" },
      { kind: "end", name: "root" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects an end-namespace prefix outside the string pool", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "", uri: "urn:a" },
      { kind: "start", name: "root" },
      { kind: "end", name: "root" },
      { kind: "endNs", prefix: "", uri: "urn:a" },
    ];
    const bytes = buildAxml(events);
    // The end-ns chunk is last; its prefix index sits at +16.
    const last = bytes.length - 24;
    bytes.writeUInt32LE(0x7fff0000, last + 16);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects bindings of reserved prefixes and URIs", async () => {
    for (const [prefix, uri] of [
      ["xml", "urn:other"],
      ["xmlns", "urn:a"],
      ["p", "http://www.w3.org/2000/xmlns/"],
      ["p", "http://www.w3.org/XML/1998/namespace"],
    ] as const) {
      const events: readonly AxmlEvent[] = [
        { kind: "startNs", prefix, uri },
        { kind: "start", name: "root" },
        { kind: "end", name: "root" },
        { kind: "endNs", prefix, uri },
      ];
      await withReader(buildAxml(events), async (reader) => {
        await expect(list(reader), `${prefix}=${uri}`).rejects.toMatchObject({
          reason: "malformed",
        });
      });
    }
  });

  it("rejects a duplicate attribute after resource-map inference", async () => {
    const ANDROID = "http://schemas.android.com/apk/res/android";
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "android", uri: ANDROID },
      {
        kind: "start",
        name: "e",
        attrs: [
          // Unqualified name mapped into the Android namespace, then an
          // explicitly namespaced twin: both project as android:name.
          { name: "name", value: "a" },
          { name: "name", ns: ANDROID, value: "b" },
        ],
      },
      { kind: "end", name: "e" },
      { kind: "endNs", prefix: "android", uri: ANDROID },
    ];
    await withReader(
      buildAxml(events, { resourceIds: { name: 0x01010003 } }),
      async (reader) => {
        await expect(list(reader)).rejects.toMatchObject({
          reason: "malformed",
        });
      },
    );
  });

  it("resets the default namespace on a no-namespace child", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "", uri: "urn:x" },
      { kind: "start", name: "root", ns: "urn:x" },
      { kind: "start", name: "bare" },
      { kind: "end", name: "bare" },
      { kind: "end", name: "root" },
      { kind: "endNs", prefix: "", uri: "urn:x" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('<bare xmlns=""/>');
    });
  });

  it("re-emits a namespace binding on a sibling outside the first scope", async () => {
    // The declaration lands mid-document: it is emitted on `first`, whose
    // scope cannot cover its sibling, so `second` needs it again.
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "root" },
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      { kind: "start", name: "first", ns: "urn:a" },
      { kind: "end", name: "first" },
      { kind: "start", name: "second", ns: "urn:a" },
      { kind: "end", name: "second" },
      { kind: "endNs", prefix: "p", uri: "urn:a" },
      { kind: "end", name: "root" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('<p:first xmlns:p="urn:a"');
      expect(xml).toContain('<p:second xmlns:p="urn:a"');
    });
  });

  it("collapses expanded 4-bit color channels", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "e",
        attrs: [
          // Expanded storage: each output nibble is the high half of a byte.
          { name: "a4", typed: [0x1e, 0xff00aa88] },
          { name: "r4", typed: [0x1f, 0x0000aa88] },
        ],
      },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('a4="#f0a8"');
      expect(xml).toContain('r4="#0a8"');
    });
  });

  it("keeps the type code on reserved typed values", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "e",
        attrs: [{ name: "mystery", typed: [0x09, 0x11223344] }],
      },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('mystery="(type 0x09)0x11223344"');
    });
  });

  it("rejects an attribute record with a malformed value header", async () => {
    const bytes = buildAxml([
      {
        kind: "start",
        name: "e",
        attrs: [{ name: "a", value: "v" }],
      },
      { kind: "end", name: "e" },
    ]);
    // Attribute record Res_value.size sits at chunk base + 16 + 20 + 12.
    let cursor = 8 + bytes.readUInt32LE(12);
    bytes.writeUInt16LE(6, cursor + 16 + 20 + 12);
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("rejects malformed string bytes instead of inserting U+FFFD", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "e",
        attrs: [{ name: "a", value: "ok" }],
      },
      { kind: "end", name: "e" },
    ];
    const bytes = buildAxml(events, { utf8: true });
    // Corrupt one byte inside the "ok" string data: the last pool entry.
    const poolBase = 8;
    const stringsStart = poolBase + bytes.readUInt32LE(poolBase + 28 - 8);
    const count = bytes.readUInt32LE(poolBase + 8);
    const last = bytes.readUInt32LE(poolBase + 28 + (count - 1) * 4);
    bytes[stringsStart + last + 3] = 0xff;
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "malformed" });
    });
  });

  it("emits comments attached to namespace records", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "p", uri: "urn:a", comment: "ns-note" },
      { kind: "start", name: "root" },
      { kind: "end", name: "root" },
      { kind: "endNs", prefix: "p", uri: "urn:a", comment: "ns-tail" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain("<!--ns-note-->");
      expect(xml).toContain("<!--ns-tail-->");
    });
  });

  it("marks unexamined carrier tails as unknown coverage", async () => {
    const bytes = Buffer.concat([
      buildAxml(AXML_MANIFEST_EVENTS),
      Buffer.from([1, 2, 3, 4]),
    ]);
    await withReader(bytes, async (reader) => {
      let coverage:
        | { status: string; limitations: readonly string[] }
        | undefined;
      await list(reader, {
        onCoverage: (c) => {
          coverage = c;
        },
      });
      expect(coverage?.status).toBe("unknown");
    });
  });
});
