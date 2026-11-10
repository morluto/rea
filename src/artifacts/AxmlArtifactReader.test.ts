import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  AXML_MANIFEST_EVENTS,
  buildAxml,
  type AxmlEvent,
} from "../../tests/fixtures/axml.js";

import type {
  ArtifactEntry,
  ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { hasAxmlHeader, readAxmlHeaderFacts } from "../domain/axmlFormat.js";
import { AxmlArtifactReader } from "./AxmlArtifactReader.js";

const writeDocument = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-axml-"),
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

describe("hasAxmlHeader", () => {
  it("recognizes the RES_XML_TYPE preamble only", () => {
    expect(hasAxmlHeader(buildAxml(AXML_MANIFEST_EVENTS))).toBe(true);
    expect(hasAxmlHeader(buildAxml(AXML_MANIFEST_EVENTS, { utf8: true }))).toBe(
      true,
    );
    expect(hasAxmlHeader(Buffer.from("PK\x03\x04"))).toBe(false);
    expect(hasAxmlHeader(Buffer.alloc(4))).toBe(false);
    // Malformed documents keep format identity; the decoder reports details.
    expect(
      hasAxmlHeader(Buffer.from([0x03, 0x00, 0x08, 0x00, 1, 2, 3, 4])),
    ).toBe(true);
    expect(
      hasAxmlHeader(Buffer.from([0x03, 0x00, 0x09, 0x00, 1, 2, 3, 4])),
    ).toBe(false);
  });
});

describe("readAxmlHeaderFacts", () => {
  it("reads the declared document size", () => {
    const bytes = buildAxml(AXML_MANIFEST_EVENTS);
    expect(readAxmlHeaderFacts(bytes)).toEqual({
      declaredSize: bytes.length,
    });
    expect(readAxmlHeaderFacts(Buffer.alloc(32))).toBeUndefined();
  });
});

describe("AxmlArtifactReader", () => {
  it("decodes a manifest-shaped document into XML text", async () => {
    await withReader(buildAxml(AXML_MANIFEST_EVENTS), async (reader) => {
      const entries = await list(reader);
      expect(entries.map((entry) => entry.path)).toEqual(["document.xml"]);
      const metadata = reader.formatMetadata();
      expect(metadata).toMatchObject({
        kind: "axml",
        element_count: 3,
        attribute_count: 5,
        namespace_count: 1,
        declared_size: buildAxml(AXML_MANIFEST_EVENTS).length,
      });
      const xml = await text(await reader.open(entries[0]!));
      expect(xml).toContain('package="com.example.app"');
      expect(xml).toContain('android:versionCode="3"');
      expect(xml).toContain('android:versionName="1.0"');
      expect(xml).toContain(
        'xmlns:android="http://schemas.android.com/apk/res/android"',
      );
      expect(xml).toContain(
        '<activity android:name=".MainActivity" android:exported="true"/>',
      );
      expect(xml).toContain("</manifest>");
    });
  });

  it("renders every typed attribute value literally", async () => {
    const ANDROID = "http://schemas.android.com/apk/res/android";
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "android", uri: ANDROID },
      {
        kind: "start",
        name: "uses-sdk",
        attrs: [
          { name: "minSdkVersion", ns: ANDROID, typed: [0x10, 24] },
          { name: "targetSdk", ns: ANDROID, typed: [0x11, 0x22] },
          { name: "required", ns: ANDROID, typed: [0x12, 0] },
          { name: "theme", ns: ANDROID, typed: [0x01, 0x7f0a0012] },
          { name: "color", ns: ANDROID, typed: [0x1d, 0xff336699] },
          { name: "colorArgb", ns: ANDROID, typed: [0x1c, 0xff336699] },
          { name: "label", ns: ANDROID, typed: [0x03, 0] },
        ],
      },
      { kind: "end", name: "uses-sdk" },
      { kind: "endNs", prefix: "android", uri: ANDROID },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('android:minSdkVersion="24"');
      expect(xml).toContain('android:targetSdk="0x00000022"');
      expect(xml).toContain('android:required="false"');
      expect(xml).toContain('android:theme="@0x7f0a0012"');
      expect(xml).toContain('android:color="#336699"');
      expect(xml).toContain('android:colorArgb="#ff336699"');
    });
  });

  it("rejects a carrier truncated inside a chunk", async () => {
    const full = buildAxml(AXML_MANIFEST_EVENTS);
    await withReader(full.subarray(0, full.length - 12), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects malformed chunk streams as typed format failures", async () => {
    const cases: Record<string, Buffer> = {
      "missing string pool": Buffer.from([
        0x03, 0x00, 0x08, 0x00, 0x10, 0x00, 0x00, 0x00, 0x03, 0x01, 0x08, 0x00,
        0x08, 0x00, 0x00, 0x00,
      ]),
      "header only": Buffer.from([
        0x03, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00,
      ]),
      "bad declared size": (() => {
        const b = buildAxml(AXML_MANIFEST_EVENTS);
        b.writeUInt32LE(4, 4);
        return b;
      })(),
      "duplicate string pool": (() => {
        const b = buildAxml(AXML_MANIFEST_EVENTS);
        const poolBytes = b.subarray(8, 8 + b.readUInt32LE(12));
        return buildAxml(AXML_MANIFEST_EVENTS, { tailChunks: [poolBytes] });
      })(),
      "unclosed element": buildAxml([{ kind: "start", name: "manifest" }]),
      "mismatched end": buildAxml([
        { kind: "start", name: "manifest" },
        { kind: "end", name: "other" },
      ]),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      await withReader(bytes, async (reader) => {
        await expect(list(reader), name).rejects.toMatchObject({
          reason: "format",
        });
      });
    }
  });
});

describe("axml value rendering", () => {
  it("renders dimension and fraction values with Android radix scales", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "view",
        attrs: [
          // mantissa 16 << 8 | radix 3 (1.0) | unit 1 (dip) → "16dip"
          { name: "width", typed: [0x05, (16 << 8) | (3 << 4) | 1] },
          // negative mantissa -2 << 8 | radix 2 (1/128) | unit 0 (px) → -0.015625px
          { name: "offset", typed: [0x05, (-2 << 8) | (2 << 4) | 0] },
          // mantissa 256 << 8 | radix 0 (2^-23) | fraction unit 0 → percent
          { name: "weight", typed: [0x06, (256 << 8) | (0 << 4) | 0] },
        ],
      },
      { kind: "end", name: "view" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('width="16dip"');
      expect(xml).toContain('offset="-0.015625px"');
      expect(xml).toContain('weight="0.0030517578125%"');
    });
  });

  it("distinguishes @null and @empty typed nulls", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "view",
        attrs: [
          { name: "missing", typed: [0x00, 0] },
          { name: "empty", typed: [0x00, 1] },
        ],
      },
      { kind: "end", name: "view" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('missing="@null"');
      expect(xml).toContain('empty="@empty"');
    });
  });

  it("scopes namespace prefixes to their declarations", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "a", uri: "urn:x" },
      { kind: "start", name: "root" },
      { kind: "endNs", prefix: "a", uri: "urn:x" },
      { kind: "startNs", prefix: "b", uri: "urn:x" },
      { kind: "start", name: "child", ns: "urn:x" },
      { kind: "end", name: "child" },
      { kind: "endNs", prefix: "b", uri: "urn:x" },
      { kind: "end", name: "root" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain("<b:child");
      expect(xml).not.toContain("<a:child");
    });
  });

  it("synthesizes xmlns:android for resource-map prefixes", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "activity",
        attrs: [{ name: "name", value: ".Main" }],
      },
      { kind: "end", name: "activity" },
    ];
    await withReader(
      buildAxml(events, { resourceIds: { name: 0x01010003 } }),
      async (reader) => {
        const xml = await text(await reader.open((await list(reader))[0]!));
        expect(xml).toContain('android:name=".Main"');
        expect(xml).toContain(
          'xmlns:android="http://schemas.android.com/apk/res/android"',
        );
      },
    );
  });

  it("preserves cdata text and attribute whitespace literally", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "label",
        attrs: [{ name: "text", value: "a\tb\nc" }],
      },
      { kind: "cdata", text: "keep  my   spaces" },
      { kind: "end", name: "label" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('text="a&#9;b&#10;c"');
      expect(xml).toContain(
        '<label text="a&#9;b&#10;c">keep  my   spaces</label>',
      );
    });
  });

  it("reports trailing carrier bytes as a limitation", async () => {
    const bytes = Buffer.concat([
      buildAxml(AXML_MANIFEST_EVENTS),
      Buffer.from([1, 2, 3, 4]),
    ]);
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
        "carrier bytes follow the declared document",
      );
    });
  });

  it("decodes UTF-8 pools including two-byte length strings", async () => {
    const long = "x".repeat(300);
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "v", attrs: [{ name: "t", value: long }] },
      { kind: "end", name: "v" },
    ];
    await withReader(buildAxml(events, { utf8: true }), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain(`t="${long}"`);
    });
  });

  it("uses the resource map for android-prefixed names without a URI", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "activity",
        attrs: [{ name: "name", value: ".Main" }],
      },
      { kind: "end", name: "activity" },
    ];
    await withReader(
      buildAxml(events, { resourceIds: { name: 0x01010003 } }),
      async (reader) => {
        const xml = await text(await reader.open((await list(reader))[0]!));
        expect(xml).toContain('android:name=".Main"');
      },
    );
  });
});

describe("axml attribute namespaces", () => {
  it("renders dynamic reference and attribute value kinds", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "e",
        attrs: [
          { name: "r", typed: [0x07, 0x7f010001] },
          { name: "t", typed: [0x08, 0x7f020002] },
        ],
      },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('r="@0x7f010001"');
      expect(xml).toContain('t="?0x7f020002"');
    });
  });

  it("synthesizes a prefix for attributes in a default-bound namespace", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "", uri: "urn:x" },
      {
        kind: "start",
        name: "e",
        ns: "urn:x",
        attrs: [{ name: "a", ns: "urn:x", value: "v" }],
      },
      { kind: "end", name: "e" },
      { kind: "endNs", prefix: "", uri: "urn:x" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('xmlns:ns1="urn:x"');
      expect(xml).toContain('ns1:a="v"');
    });
  });

  it("preserves a leading U+FEFF in pool strings", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "e", attrs: [{ name: "v", value: "\uFEFFx" }] },
      { kind: "end", name: "e" },
    ];
    for (const utf8 of [false, true]) {
      await withReader(buildAxml(events, { utf8 }), async (reader) => {
        const xml = await text(await reader.open((await list(reader))[0]!));
        expect(xml).toContain('v="\uFEFFx"');
      });
    }
  });

  it("renders the predefined xml namespace without a declaration", async () => {
    const events: readonly AxmlEvent[] = [
      {
        kind: "start",
        name: "e",
        attrs: [
          {
            name: "lang",
            ns: "http://www.w3.org/XML/1998/namespace",
            value: "zh",
          },
        ],
      },
      { kind: "end", name: "e" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('xml:lang="zh"');
      expect(xml).not.toContain('xmlns:xml="');
    });
  });

  it("emits declared node comments at their event positions", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "e", comment: "generated" },
      { kind: "cdata", text: "t", comment: "inner" },
      { kind: "end", name: "e", comment: "tail" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain("<!-- generated -->");
      expect(xml).toContain("<!-- inner -->");
      expect(xml).toContain("<!-- tail -->");
    });
  });
});

describe("axml inventory", () => {
  it("classifies and inventories the document via the canonical scan", async () => {
    const inventory = await scanCanonicalArtifactInventory(
      await writeDocument(buildAxml(AXML_MANIFEST_EVENTS)),
    );
    expect(inventory.manifest.root_format).toBe("axml");
    expect(inventory.coverage.status).toBe("complete");
    expect(inventory.occurrences.map((row) => row.logical_path).sort()).toEqual(
      [".", "document.xml"],
    );
  });
});

describe("axml scope and malformed regressions", () => {
  it("resolves an attribute URI past a shadowed prefix", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      { kind: "startNs", prefix: "q", uri: "urn:a" },
      { kind: "start", name: "root" },
      { kind: "startNs", prefix: "q", uri: "urn:b" },
      {
        kind: "start",
        name: "inner",
        attrs: [{ name: "attr", ns: "urn:a", value: "v" }],
      },
      { kind: "end", name: "inner" },
      { kind: "end", name: "root" },
      { kind: "endNs", prefix: "q", uri: "urn:b" },
      { kind: "endNs", prefix: "q", uri: "urn:a" },
      { kind: "endNs", prefix: "p", uri: "urn:a" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      // q now names urn:b; the urn:a attribute must serialize under p.
      expect(xml).toContain('xmlns:q="urn:b"');
      expect(xml).toContain('p:attr="v"');
      expect(xml).not.toContain('q:attr="v"');
    });
  });

  it("restores a shadowed outer prefix binding after end-ns", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      { kind: "start", name: "root" },
      { kind: "startNs", prefix: "p", uri: "urn:b" },
      {
        kind: "start",
        name: "inner",
        attrs: [{ name: "attr", ns: "urn:b", value: "v" }],
      },
      { kind: "end", name: "inner" },
      { kind: "endNs", prefix: "p", uri: "urn:b" },
      {
        kind: "start",
        name: "outer",
        attrs: [{ name: "attr", ns: "urn:a", value: "w" }],
      },
      { kind: "end", name: "outer" },
      { kind: "end", name: "root" },
      { kind: "endNs", prefix: "p", uri: "urn:a" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      const xml = await text(await reader.open((await list(reader))[0]!));
      expect(xml).toContain('p:attr="v"');
      expect(xml).toContain('p:attr="w"');
    });
  });

  it("rejects an end-ns that does not match the open declaration", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      { kind: "startNs", prefix: "q", uri: "urn:b" },
      { kind: "endNs", prefix: "p", uri: "urn:a" },
      { kind: "start", name: "root" },
      { kind: "end", name: "root" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects duplicate expanded attribute names", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "startNs", prefix: "p", uri: "urn:a" },
      {
        kind: "start",
        name: "root",
        attrs: [
          { name: "attr", ns: "urn:a", value: "1" },
          { name: "attr", ns: "urn:a", value: "2" },
        ],
      },
      { kind: "end", name: "root" },
      { kind: "endNs", prefix: "p", uri: "urn:a" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects character data outside the root element", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "cdata", text: "loose" },
      { kind: "start", name: "root" },
      { kind: "end", name: "root" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("reports unrecognized chunks as a limitation", async () => {
    const mystery = Buffer.alloc(16);
    mystery.writeUInt16LE(0x0204, 0);
    mystery.writeUInt16LE(8, 2);
    mystery.writeUInt32LE(16, 4);
    const bytes = buildAxml(AXML_MANIFEST_EVENTS, {
      tailChunks: [mystery],
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
      expect(entries[0]!.path).toBe("document.xml");
      expect(coverage?.limitations.join(" ")).toContain(
        "unrecognized chunks were skipped",
      );
    });
  });

  it("rejects pool strings carrying XML-forbidden characters", async () => {
    const events: readonly AxmlEvent[] = [
      { kind: "start", name: "root" },
      { kind: "cdata", text: "ab" },
      { kind: "end", name: "root" },
    ];
    await withReader(buildAxml(events), async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });

  it("rejects a UTF-8 string whose two length fields disagree", async () => {
    const bytes = buildAxml(
      [
        { kind: "start", name: "root" },
        { kind: "end", name: "root" },
      ],
      { utf8: true },
    );
    // First string in the pool: bump its declared UTF-16 length by one.
    const stringsStart = bytes.readUInt32LE(8 + 8 + 12);
    bytes[8 + stringsStart]! += 1;
    await withReader(bytes, async (reader) => {
      await expect(list(reader)).rejects.toMatchObject({ reason: "format" });
    });
  });
});
