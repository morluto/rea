import { expect, it } from "vitest";

import { ParseFailureError } from "../parseFailure.js";
import {
  IMAGE4_DER_DEPTH_LIMIT,
  IMAGE4_DER_ELEMENTS_LIMIT,
  IMAGE4_MAX_DEPTH,
  IMAGE4_MAX_ELEMENTS,
  IMAGE4_MAX_INTEGER_BYTES,
  IMAGE4_MAX_NESTED_BYTES,
  IMAGE4_MAX_OCTET_HEX_BYTES,
  IMAGE4_MAX_PROPERTIES,
  IMAGE4_MAX_RETAINED_BYTES,
  IMAGE4_MAX_STRING_BYTES,
  IMAGE4_PROPERTIES_LIMIT,
  IMAGE4_STRING_BYTES_LIMIT,
  inspectImage4,
  type Image4ByteSource,
  type Image4Inspection,
} from "./image4.js";
import {
  SAMPLE_CERT,
  SAMPLE_DIGEST,
  SAMPLE_ECID,
  SAMPLE_IV,
  SAMPLE_KEY,
  SAMPLE_NONCE,
  SAMPLE_PAYLOAD,
  SAMPLE_SIGNATURE,
  complzssPayload,
  compressionInfo,
  derSet,
  explicit,
  ia5,
  im4m,
  im4p,
  LZFSE_ALGORITHM,
  im4r,
  img4,
  integer,
  keybag,
  octet,
  privateIdentifier,
  manifestObject,
  privateTagged,
  property,
  sequence,
  tlv,
} from "./image4.fixture.js";

const sourceOf = (
  bytes: Buffer,
  onRead?: (length: number) => void,
): Image4ByteSource => ({
  length: bytes.length,
  read: async (offset, length) => {
    onRead?.(length);
    return bytes.subarray(offset, Math.min(bytes.length, offset + length));
  },
});

const inspect = (bytes: Buffer, onRead?: (length: number) => void) =>
  inspectImage4(sourceOf(bytes, onRead));

const image4 = async (
  bytes: Buffer,
  onRead?: (length: number) => void,
): Promise<Extract<Image4Inspection, { kind: "image4" }>> => {
  const result = await inspect(bytes, onRead);
  expect(result.kind).toBe("image4");
  if (result.kind !== "image4") throw new Error("unreachable");
  return result;
};

const depthBomb = (): Buffer => {
  let inner = sequence();
  for (let count = 0; count < IMAGE4_MAX_DEPTH + 1; count += 1)
    inner = sequence(inner);
  return sequence(ia5("IM4P"), inner);
};

const elementBomb = (): Buffer => {
  const empties = Buffer.alloc(IMAGE4_MAX_ELEMENTS * 2);
  for (let index = 0; index < IMAGE4_MAX_ELEMENTS; index += 1) {
    empties[index * 2] = 0x30;
    empties[index * 2 + 1] = 0;
  }
  return sequence(ia5("IM4P"), empties);
};

it("reports a plain IM4P payload range", async () => {
  const bytes = im4p();
  const result = await image4(bytes);
  expect(result.facts).toMatchObject({
    magic: "IM4P",
    trailing_bytes: 0,
    manifest: null,
    restore_info: null,
    payload: {
      type: "krnl",
      description: "Kernelcache",
      compression: "none",
      uncompressed_size: null,
      payload_magic: null,
      encrypted: false,
      keybag_count: 0,
      keybag_types: [],
    },
  });
  const payload = result.facts.payload;
  expect(payload).not.toBeNull();
  expect(
    bytes
      .subarray(
        payload?.offset,
        (payload?.offset ?? 0) + (payload?.length ?? 0),
      )
      .equals(SAMPLE_PAYLOAD),
  ).toBe(true);
  expect(result.entries.map((entry) => entry.path)).toEqual(["payload"]);
  expect(result.limitations).toEqual([]);
});

it("sniffs an LZFSE bvx2 payload and a complzss uncompressed size", async () => {
  const lzfse = Buffer.from("bvx2-payload");
  const lzfseResult = await image4(im4p({ payload: lzfse }));
  expect(lzfseResult.facts.payload).toMatchObject({
    compression: "bvx2",
    payload_magic: "bvx2",
    uncompressed_size: null,
    length: lzfse.length,
  });

  const compressed = complzssPayload(0x01020304);
  const result = await image4(im4p({ payload: compressed }));
  expect(compressed.length).toBeGreaterThan(16);
  expect(compressed.readUInt32BE(8)).not.toBe(0x01020304);
  expect(result.facts.payload).toMatchObject({
    compression: "complzss",
    payload_magic: "complzss",
    uncompressed_size: 0x01020304,
  });
  expect(result.limitations).toEqual([]);

  const short = Buffer.alloc(12);
  short.write("complzss", 0, "ascii");
  short.writeUInt32BE(0x01020304, 8);
  const shortResult = await image4(im4p({ payload: short }));
  expect(shortResult.facts.payload).toMatchObject({
    compression: "complzss",
    payload_magic: "complzss",
    uncompressed_size: null,
  });
  expect(shortResult.limitations.join("\n")).toContain("shorter than 16");
});

it("prefers explicit compression info and records a magic disagreement", async () => {
  const tagged = await image4(
    im4p({
      payload: Buffer.from("plain"),
      compression: compressionInfo(LZFSE_ALGORITHM, 1234),
    }),
  );
  expect(tagged.facts.payload).toMatchObject({
    compression: "bvx2",
    uncompressed_size: 1234,
    payload_magic: null,
  });
  expect(tagged.limitations).toEqual([]);

  const disagreed = await image4(
    im4p({
      payload: complzssPayload(4096),
      compression: compressionInfo(LZFSE_ALGORITHM, 99),
    }),
  );
  expect(disagreed.facts.payload).toMatchObject({
    compression: "bvx2",
    uncompressed_size: 99,
    payload_magic: "complzss",
  });
  expect(disagreed.limitations.join("\n")).toContain("disagrees");
});

it("keeps the sniffed compression for an algorithm other than LZFSE", async () => {
  const result = await image4(
    im4p({
      payload: Buffer.from("bvx2-payload"),
      compression: compressionInfo(7, 99),
    }),
  );
  expect(result.facts.payload).toMatchObject({
    compression: "bvx2",
    uncompressed_size: null,
    payload_magic: "bvx2",
  });
  expect(result.limitations.join("\n")).toContain(
    "compression algorithm 7 is not LZFSE",
  );
});

it("treats LZFSE block magics other than bvx2 as compressed", async () => {
  for (const magic of ["bvxn", "bvx1", "bvx-"] as const) {
    const result = await image4(
      im4p({ payload: Buffer.from(`${magic}-payload`) }),
    );
    expect(result.facts.payload).toMatchObject({
      compression: magic,
      payload_magic: magic,
      uncompressed_size: null,
    });
    expect(result.entries[0]).toMatchObject({ compression: magic });
    expect(result.limitations).toEqual([]);
  }

  const declared = await image4(
    im4p({
      payload: Buffer.from("bvxn-payload"),
      compression: compressionInfo(LZFSE_ALGORITHM, 50),
    }),
  );
  expect(declared.facts.payload).toMatchObject({
    compression: "bvx2",
    uncompressed_size: 50,
    payload_magic: "bvxn",
  });
  expect(declared.limitations).toEqual([]);

  const unknown = await image4(im4p({ payload: Buffer.from("bvxx-payload") }));
  expect(unknown.facts.payload).toMatchObject({
    compression: "none",
    payload_magic: null,
  });
  expect(unknown.limitations.join("\n")).toContain("bvxx");
});

it("reports keybag count and types without IV or key bytes", async () => {
  const result = await image4(
    im4p({
      keybag: keybag([
        { type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY },
        { type: 2, iv: SAMPLE_IV, key: SAMPLE_KEY },
      ]),
    }),
  );
  expect(result.facts.payload).toMatchObject({
    encrypted: true,
    keybag_count: 2,
    keybag_types: [1, 2],
  });
  expect(result.entries[0]).toMatchObject({ encrypted: true });
  const json = JSON.stringify(result);
  expect(json).not.toContain(SAMPLE_IV.toString("hex"));
  expect(json).not.toContain(SAMPLE_KEY.toString("hex"));
});

it("still reports a payload type that is not four characters", async () => {
  const result = await image4(im4p({ type: "k" }));
  expect(result.facts.payload?.type).toBe("k");
  expect(result.limitations.join("\n")).toContain("1 characters");
});

it("decodes an IM4M manifest with digests as hex", async () => {
  const bytes = im4m();
  const result = await image4(bytes);
  expect(result.facts.magic).toBe("IM4M");
  expect(result.facts.payload).toBeNull();
  expect(result.entries.map((entry) => entry.path)).toEqual(["manifest.der"]);
  expect(result.facts.manifest).toMatchObject({
    version: "0",
    signature_size: SAMPLE_SIGNATURE.length,
    certificate_chain_size: octet(SAMPLE_CERT).length,
    properties: [
      { name: "CHIP", value: { type: "integer", decimal: "32816" } },
      { name: "BORD", value: { type: "integer", decimal: "4" } },
      {
        name: "ECID",
        value: { type: "integer", decimal: SAMPLE_ECID.toString(10) },
      },
      { name: "CPRO", value: { type: "boolean", value: true } },
      { name: "SDOM", value: { type: "integer", decimal: "1" } },
    ],
    objects: [
      {
        name: "ibot",
        digest_hex: SAMPLE_DIGEST.toString("hex"),
      },
    ],
  });
  const entry = result.entries[0];
  expect(entry).toBeDefined();
  const manifest = bytes.subarray(
    entry?.offset,
    (entry?.offset ?? 0) + (entry?.length ?? 0),
  );
  expect(manifest[0]).toBe(0x30);
  expect(manifest.includes(Buffer.from("IM4M"))).toBe(true);
  expect(manifest.equals(bytes.subarray(0, bytes.length))).toBe(true);
});

it("exposes IMG4 payload, manifest and redacted restore info", async () => {
  const payload = im4p();
  const manifest = im4m();
  const restore = im4r();
  const bytes = img4(payload, manifest, restore);
  const result = await image4(bytes);
  expect(result.facts.magic).toBe("IMG4");
  expect(result.entries.map((entry) => entry.path)).toEqual([
    "payload",
    "manifest.der",
    "restore-info.der",
  ]);
  expect(result.facts.restore_info).toEqual({
    properties_present: ["BNCN"],
    values: "redacted",
  });
  expect(result.facts.manifest?.objects[0]?.digest_hex).toBe(
    SAMPLE_DIGEST.toString("hex"),
  );
  const json = JSON.stringify(result);
  expect(json).not.toContain(SAMPLE_NONCE.toString("utf8"));
  expect(json).not.toContain(SAMPLE_NONCE.toString("hex"));
  const manifestEntry = result.entries[1];
  const manifestBytes = bytes.subarray(
    manifestEntry?.offset,
    (manifestEntry?.offset ?? 0) + (manifestEntry?.length ?? 0),
  );
  expect(manifestBytes.equals(manifest)).toBe(true);
  expect(manifestBytes[0]).toBe(0x30);
  const restoreEntry = result.entries[2];
  expect(
    bytes
      .subarray(
        restoreEntry?.offset,
        (restoreEntry?.offset ?? 0) + (restoreEntry?.length ?? 0),
      )
      .equals(restore),
  ).toBe(true);
});

it("leaves a missing or non-decimal manifest version unknown", async () => {
  const absent = await image4(
    sequence(ia5("IM4M"), derSet(), octet(SAMPLE_SIGNATURE)),
  );
  expect(absent.facts.manifest?.version).toBeNull();
  expect(absent.limitations.join("\n")).toContain("version is absent");

  const negative = await image4(
    sequence(ia5("IM4M"), integer(-1), derSet(), octet(SAMPLE_SIGNATURE)),
  );
  expect(negative.facts.manifest?.version).toBeNull();
  expect(negative.limitations.join("\n")).toContain("not an unsigned decimal");

  const observed = await image4(
    sequence(ia5("IM4M"), integer(0), derSet(), octet(SAMPLE_SIGNATURE)),
  );
  expect(observed.facts.manifest?.version).toBe("0");
  expect(observed.limitations.join("\n")).not.toContain("manifest version");
});

it("keeps an indefinite payload and reports trailing bytes and unknown tags", async () => {
  const indefinite = await image4(
    im4p({ indefinite: true, payload: SAMPLE_PAYLOAD }),
  );
  expect(indefinite.facts.payload?.length).toBe(SAMPLE_PAYLOAD.length);
  expect(indefinite.limitations.join("\n")).toContain("indefinite length");

  const trailing = await image4(Buffer.concat([im4p(), Buffer.from([0xde])]));
  expect(trailing.facts.trailing_bytes).toBe(1);
  expect(trailing.limitations.join("\n")).toContain("trailing bytes");

  const unknown = await image4(im4p({ extra: [integer(7)] }));
  expect(unknown.limitations.join("\n")).toContain("Unknown Image4 tag 0x02");

  const body = Buffer.concat([
    ia5("IM4P"),
    Buffer.alloc(IMAGE4_MAX_NESTED_BYTES),
  ]);
  const unbounded = await image4(
    Buffer.concat([Buffer.from([0x30, 0x80]), body]),
  );
  expect(unbounded.facts.trailing_bytes).toBeNull();
  expect(unbounded.facts.payload).toBeNull();
  expect(unbounded.limitations.join("\n")).toContain("indefinite length");
});

it("omits a wide integer and a long octet property", async () => {
  const wide = tlv(0x02, Buffer.alloc(IMAGE4_MAX_INTEGER_BYTES + 1, 0x01));
  const longOctet = octet(Buffer.alloc(IMAGE4_MAX_OCTET_HEX_BYTES + 1, 0xab));
  const result = await image4(
    im4m({
      properties: [
        property("WIDE", wide),
        property("LONG", longOctet),
        property("ODDB", tlv(0x01, Buffer.from([0x01]))),
      ],
    }),
  );
  expect(result.facts.manifest?.properties).toEqual(
    expect.arrayContaining([
      {
        name: "WIDE",
        value: { type: "omitted", byte_length: IMAGE4_MAX_INTEGER_BYTES + 1 },
      },
      {
        name: "LONG",
        value: { type: "omitted", byte_length: IMAGE4_MAX_OCTET_HEX_BYTES + 1 },
      },
      { name: "ODDB", value: { type: "boolean", value: true } },
    ]),
  );
  expect(result.limitations.join("\n")).toContain("omitted");
  expect(result.limitations.join("\n")).toContain("not canonical");
});

it("does not claim an Image4 container for other bytes", async () => {
  expect((await inspect(Buffer.from("hello"))).kind).toBe("unrecognized");
  expect((await inspect(Buffer.alloc(0))).kind).toBe("unrecognized");
});

it("refuses DER depth, element, property and string ceilings", async () => {
  await expect(inspect(depthBomb())).rejects.toBeInstanceOf(ParseFailureError);
  await expect(inspect(depthBomb())).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: IMAGE4_DER_DEPTH_LIMIT, maximum: IMAGE4_MAX_DEPTH },
    },
  });
  await expect(inspect(elementBomb())).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: IMAGE4_DER_ELEMENTS_LIMIT, maximum: IMAGE4_MAX_ELEMENTS },
    },
  });
  const properties = Array.from(
    { length: IMAGE4_MAX_PROPERTIES + 1 },
    (_, index) => property(`P${String(index).padStart(3, "0")}`, integer(1)),
  );
  await expect(inspect(im4m({ properties }))).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: IMAGE4_PROPERTIES_LIMIT, maximum: IMAGE4_MAX_PROPERTIES },
    },
  });
  await expect(
    inspect(im4p({ description: "A".repeat(IMAGE4_MAX_STRING_BYTES + 1) })),
  ).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: {
        name: IMAGE4_STRING_BYTES_LIMIT,
        maximum: IMAGE4_MAX_STRING_BYTES,
      },
    },
  });
});

it("rejects a truncated container and a high-tag form for a low tag number", async () => {
  const full = im4p();
  await expect(inspect(full.subarray(0, 12))).rejects.toMatchObject({
    failure: { kind: "truncated" },
  });
  await expect(
    inspect(sequence(ia5("IM4P"), Buffer.from([0x1f, 0x01, 0x00]))),
  ).rejects.toMatchObject({ failure: { kind: "malformed" } });
});

it("ranges a payload larger than the nested parse without reading it", async () => {
  const payload = Buffer.alloc(IMAGE4_MAX_NESTED_BYTES, 0x5a);
  payload.write("bvx2");
  let readBytes = 0;
  const result = await image4(im4p({ payload }), (length) => {
    readBytes += length;
  });
  expect(result.facts.payload).toMatchObject({
    length: IMAGE4_MAX_NESTED_BYTES,
    compression: "bvx2",
    payload_magic: "bvx2",
  });
  expect(readBytes).toBeLessThan(IMAGE4_MAX_NESTED_BYTES);
});

it("keeps an empty manifest object name and a non-minimal length", async () => {
  const body = derSet(
    sequence(ia5("MANB"), derSet(sequence(ia5(""), derSet()))),
  );
  const manifest = sequence(
    ia5("IM4M"),
    integer(0),
    body,
    octet(SAMPLE_SIGNATURE),
  );
  const emptyName = await image4(manifest);
  expect(emptyName.facts.manifest?.objects).toEqual([]);
  expect(emptyName.limitations.join("\n")).toContain("empty name");

  const payload = octet(Buffer.from("abc"));
  const im4pBody = Buffer.concat([
    ia5("IM4P"),
    ia5("krnl"),
    ia5("Kernelcache"),
    payload,
  ]);
  const nonMinimal = await image4(
    Buffer.concat([Buffer.from([0x30, 0x81, im4pBody.length]), im4pBody]),
  );
  expect(nonMinimal.facts.payload?.type).toBe("krnl");
  expect(nonMinimal.limitations.join("\n")).toContain("non-minimal length");
});

it("treats an empty keybag as present and the payload as encrypted", async () => {
  const result = await image4(im4p({ keybag: keybag([]) }));
  expect(result.facts.payload).toMatchObject({
    encrypted: true,
    keybag_count: 0,
  });
  expect(result.entries[0]).toMatchObject({ encrypted: true });
  expect(result.limitations.join("\n")).toContain("empty");
});

it("never reports a payload as plain when its keybag is not recognized", async () => {
  for (const bag of [
    octet(Buffer.from("not-der-keybag")),
    octet(sequence(integer(1))),
    octet(Buffer.from([0x30, 0x05, 0x02])),
  ]) {
    const result = await image4(im4p({ keybag: bag }));
    // A keybag that was not decoded has an unknown count, not zero.
    expect(result.facts.payload).toMatchObject({
      encrypted: true,
      keybag_count: null,
      keybag_types: null,
    });
    expect(result.entries[0]).toMatchObject({ encrypted: true });
    expect(result.limitations.join("\n")).toContain("keybag");
  }
});

it("encodes manifest and restore entries as private four-character tags", async () => {
  const manifest = im4m();
  // The MANB entry: PRIVATE, constructed, high-tag-number form.
  expect(manifest.includes(privateIdentifier("MANB"))).toBe(true);
  expect(privateIdentifier("MANB")[0]).toBe(0xff);
  const result = await image4(img4(im4p(), manifest, im4r()));
  expect(result.facts.manifest?.properties.map((row) => row.name)).toEqual([
    "CHIP",
    "BORD",
    "ECID",
    "CPRO",
    "SDOM",
  ]);
  expect(result.facts.restore_info?.properties_present).toEqual(["BNCN"]);
  expect(result.limitations).toEqual([]);
});

it("notes a private tag whose number does not match the entry name", async () => {
  const mislabeled = privateTagged(
    "BORD",
    sequence(ia5("CHIP"), integer(0x8030)),
  );
  const result = await image4(im4m({ properties: [mislabeled] }));
  expect(result.facts.manifest?.properties).toEqual([
    { name: "CHIP", value: { type: "integer", decimal: "32816" } },
  ]);
  expect(result.limitations.join("\n")).toContain("does not match its name");
});

const utf8String = (text: string | Buffer): Buffer =>
  tlv(0x0c, typeof text === "string" ? Buffer.from(text, "utf8") : text);

/** IM4M with the given certificate-chain slot. */
const manifestWithCertificates = (certificates: Buffer): Buffer =>
  sequence(
    ia5("IM4M"),
    integer(0),
    derSet(
      manifestObject(
        "MANB",
        manifestObject("MANP", property("CHIP", integer(1))),
        manifestObject("ibot", property("DGST", octet(SAMPLE_DIGEST))),
      ),
    ),
    octet(SAMPLE_SIGNATURE),
    certificates,
  );

/** A constructed OCTET STRING (identifier 0x24) holding one segment. */
const constructedOctet = (segment: Buffer): Buffer => tlv(0x24, octet(segment));

it("reports a constructed string by its universal tag number in both parse paths", async () => {
  const small = await image4(
    img4(
      im4p(),
      im4m(),
      sequence(
        ia5("IM4R"),
        derSet(property("BNCN", constructedOctet(SAMPLE_NONCE))),
      ),
    ),
  );
  expect(small.limitations.join("\n")).toContain("constructed string or octet");

  const large = await image4(
    im4p({ extra: [constructedOctet(Buffer.alloc(IMAGE4_MAX_NESTED_BYTES))] }),
  );
  expect(large.limitations.join("\n")).toContain("constructed string or octet");
});

it("keeps a constructed payload in its slot instead of promoting the keybag", async () => {
  const bag = keybag([{ type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY }]);
  const result = await image4(
    sequence(
      ia5("IM4P"),
      ia5("krnl"),
      ia5("Kernelcache"),
      constructedOctet(SAMPLE_PAYLOAD),
      bag,
    ),
  );
  expect(result.facts.payload).toBeNull();
  expect(result.entries).toEqual([]);
  expect(result.limitations.join("\n")).toContain("payload at offset");
  expect(result.limitations.join("\n")).toContain("constructed OCTET STRING");
});

it("treats a constructed keybag as present so the payload stays encrypted", async () => {
  const bag = keybag([{ type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY }]);
  const result = await image4(im4p({ keybag: tlv(0x24, bag) }));
  expect(result.facts.payload).toMatchObject({
    encrypted: true,
    keybag_count: null,
    keybag_types: null,
  });
  expect(result.entries[0]).toMatchObject({ encrypted: true });
  expect(result.limitations.join("\n")).toContain("keybag at offset");
});

it("records unknown restore members, extra property fields and a mistyped certificate chain", async () => {
  const restore = await image4(
    img4(
      im4p(),
      im4m(),
      sequence(
        ia5("IM4R"),
        derSet(property("BNCN", octet(SAMPLE_NONCE)), integer(5)),
      ),
    ),
  );
  expect(restore.facts.restore_info?.properties_present).toEqual(["BNCN"]);
  expect(restore.limitations.join("\n")).toContain("Unknown Image4 tag 0x02");
  expect(JSON.stringify(restore)).not.toContain(
    SAMPLE_NONCE.toString("latin1"),
  );

  const extraField = await image4(
    im4m({
      properties: [
        privateTagged("CHIP", sequence(ia5("CHIP"), integer(1), integer(2))),
      ],
    }),
  );
  expect(extraField.facts.manifest?.properties).toEqual([
    { name: "CHIP", value: { type: "integer", decimal: "1" } },
  ]);
  expect(extraField.limitations.join("\n")).toContain("Unknown Image4 tag");

  const mistyped = manifestWithCertificates(integer(7));
  const chain = await image4(mistyped);
  expect(chain.facts.manifest?.certificate_chain_size).toBeNull();
  expect(chain.limitations.join("\n")).toContain("Unknown Image4 tag 0x02");
});

it("decodes an unsigned 32-bit keybag type that DER sign-pads to five octets", async () => {
  const result = await image4(
    im4p({
      keybag: keybag([{ type: 0xffffffff, iv: SAMPLE_IV, key: SAMPLE_KEY }]),
    }),
  );
  expect(result.facts.payload).toMatchObject({
    keybag_count: 1,
    keybag_types: [0xffffffff],
  });
  // The only limitation is the unknown compression of an encrypted payload.
  expect(result.limitations).toEqual([
    "Image4 payload is encrypted and has no compression field; its compression is unknown.",
  ]);
});

it("decodes UTF8String text as UTF-8 and refuses to alter invalid text", async () => {
  const body = (description: Buffer): Buffer =>
    sequence(ia5("IM4P"), ia5("krnl"), description, octet(SAMPLE_PAYLOAD));
  const valid = await image4(body(utf8String("café")));
  expect(valid.facts.payload?.description).toBe("café");
  expect(valid.limitations).toEqual([]);

  const invalid = await image4(body(utf8String(Buffer.from([0x63, 0xc3]))));
  expect(invalid.facts.payload?.description).toBeNull();
  expect(invalid.limitations.join("\n")).toContain("not valid UTF-8");
});

it("recognizes a magic string with a tolerated non-minimal length", async () => {
  const content = Buffer.concat([
    Buffer.from([0x16, 0x81, 0x04]),
    Buffer.from("IM4P", "latin1"),
    ia5("krnl"),
    ia5("Kernelcache"),
    octet(SAMPLE_PAYLOAD),
  ]);
  const result = await image4(tlv(0x30, content));
  expect(result.facts.magic).toBe("IM4P");
  expect(result.facts.payload?.type).toBe("krnl");
  expect(result.limitations.join("\n")).toContain("non-minimal length");
});

it("checks the structure of a large value its consumer does not decode", async () => {
  const truncatedOctet = Buffer.from([0x04, 0x05, 0x01]);
  const manifestWith = manifestWithCertificates;
  const small = manifestWith(sequence(octet(SAMPLE_CERT), truncatedOctet));
  const large = manifestWith(
    sequence(octet(Buffer.alloc(IMAGE4_MAX_NESTED_BYTES)), truncatedOctet),
  );
  await expect(inspect(small)).rejects.toMatchObject({
    failure: { kind: "truncated" },
  });
  await expect(inspect(large)).rejects.toMatchObject({
    failure: { kind: "truncated" },
  });

  let nested = sequence();
  for (let count = 0; count < IMAGE4_MAX_DEPTH + 8; count += 1)
    nested = sequence(nested);
  await expect(
    inspect(
      manifestWith(
        sequence(octet(Buffer.alloc(IMAGE4_MAX_NESTED_BYTES)), nested),
      ),
    ),
  ).rejects.toMatchObject({
    failure: { kind: "limit", limit: { name: IMAGE4_DER_DEPTH_LIMIT } },
  });
});

it("charges each element of a large wrapper once however often it is read", async () => {
  const padding = sequence(...Array.from({ length: 2100 }, () => sequence()));
  const object = privateTagged(
    "ibot",
    sequence(
      ia5("ibot"),
      derSet(
        property("DGST", octet(SAMPLE_DIGEST)),
        property("PADD", octet(Buffer.alloc(IMAGE4_MAX_NESTED_BYTES))),
      ),
      padding,
    ),
  );
  const body = derSet(
    privateTagged(
      "MANB",
      sequence(
        ia5("MANB"),
        privateTagged(
          "MANP",
          sequence(ia5("MANP"), derSet(property("CHIP", integer(1)))),
        ),
        object,
      ),
    ),
  );
  const result = await image4(
    sequence(
      ia5("IM4M"),
      integer(0),
      body,
      octet(SAMPLE_SIGNATURE),
      sequence(octet(SAMPLE_CERT)),
    ),
  );
  expect(result.facts.manifest?.objects[0]).toMatchObject({
    name: "ibot",
    digest_hex: SAMPLE_DIGEST.toString("hex"),
  });
  expect(result.limitations.join("\n")).toContain("Unknown Image4 tag");
});

it("reads the optional IM4P fields from their reference slots", async () => {
  const bag = keybag([{ type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY }]);
  // img4tool and img4lib: data, [keybag], [compression], [PAYP in [0]].
  const ordered = await image4(
    im4p({
      keybag: bag,
      compression: compressionInfo(LZFSE_ALGORITHM, 64),
      extra: [tlv(0xa0, derSet())],
    }),
  );
  expect(ordered.facts.payload).toMatchObject({
    encrypted: true,
    keybag_count: 1,
    compression: "bvx2",
    uncompressed_size: 64,
  });
  expect(ordered.limitations.join("\n")).toContain("PAYP");

  // An OCTET STRING after the compression slot is not a keybag.
  const misplaced = await image4(
    im4p({ compression: compressionInfo(LZFSE_ALGORITHM, 64), extra: [bag] }),
  );
  expect(misplaced.facts.payload).toMatchObject({
    encrypted: false,
    keybag_count: 0,
    compression: "bvx2",
  });
  expect(misplaced.limitations.join("\n")).toContain("Unknown Image4 tag 0x04");
});

it("keeps an absent description unknown and counts every keybag entry", async () => {
  const absent = await image4(
    sequence(ia5("IM4P"), ia5("krnl"), octet(SAMPLE_PAYLOAD)),
  );
  expect(absent.facts.payload?.description).toBeNull();
  expect(absent.limitations.join("\n")).toContain("description is absent");

  const wide = sequence(
    integer(2n ** 40n),
    octet(SAMPLE_IV),
    octet(SAMPLE_KEY),
  );
  const result = await image4(
    im4p({
      keybag: octet(
        sequence(
          sequence(integer(1), octet(SAMPLE_IV), octet(SAMPLE_KEY)),
          wide,
        ),
      ),
    }),
  );
  expect(result.facts.payload).toMatchObject({
    keybag_count: 2,
    keybag_types: [1],
  });
  expect(result.limitations.join("\n")).toContain("unsigned 32-bit");
});

it("reads IMG4 slots by position instead of searching for a matching tag", async () => {
  const reordered = await image4(
    sequence(ia5("IMG4"), explicit(0, im4m()), im4p()),
  );
  expect(reordered.facts.payload).toBeNull();
  expect(reordered.facts.manifest).not.toBeNull();
  expect(reordered.limitations.join("\n")).toContain("no IM4P payload");
  expect(reordered.limitations.join("\n")).toContain("Unknown Image4 tag 0x30");

  const doubled = await image4(
    sequence(
      ia5("IMG4"),
      im4p(),
      explicit(0, Buffer.concat([im4m(), integer(1)])),
    ),
  );
  expect(doubled.facts.manifest).not.toBeNull();
  expect(doubled.limitations.join("\n")).toContain("Unknown Image4 tag 0x02");
});

it("decodes a hand-encoded IM4P laid out as img4lib, img4tool and pyimg4 describe", async () => {
  // Written byte by byte, not with the fixture builders, so the expected
  // layout is independent of the code under test.
  const iv = "11".repeat(16);
  const key = "22".repeat(32);
  const bytes = Buffer.from(
    [
      "305c", // SEQUENCE, 92 content bytes
      "1604494d3450", // IA5String "IM4P"
      "16046b726e6c", // IA5String "krnl" (type)
      "1603616263", // IA5String "abc" (description)
      "040444415441", // OCTET STRING "DATA" (payload)
      "043b", // OCTET STRING keybag, 59 bytes
      "3039", //   SEQUENCE OF keybag, 57 bytes
      "3037", //     SEQUENCE keybag, 55 bytes
      "020101", //       INTEGER 1 (type)
      `0410${iv}`, //    OCTET STRING iv
      `0420${key}`, //   OCTET STRING key
      "3006020101020140", // SEQUENCE { INTEGER 1 (LZFSE), INTEGER 64 }
    ].join(""),
    "hex",
  );
  const result = await image4(bytes);
  expect(result.facts.payload).toEqual({
    type: "krnl",
    description: "abc",
    offset: 21,
    length: 4,
    compression: "bvx2",
    uncompressed_size: 64,
    payload_magic: null,
    encrypted: true,
    keybag_count: 1,
    keybag_types: [1],
  });
  expect(result.limitations).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(iv);
});

it("keeps the compression of an encrypted payload without a compression field unknown", async () => {
  const bag = keybag([{ type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY }]);
  const result = await image4(
    im4p({ payload: complzssPayload(4096), keybag: bag }),
  );
  expect(result.facts.payload).toMatchObject({
    encrypted: true,
    compression: "unknown",
    uncompressed_size: null,
  });
  expect(result.limitations.join("\n")).toContain("compression is unknown");

  const unnamed = await image4(
    im4p({ payload: Buffer.from("plain"), compression: compressionInfo(7, 9) }),
  );
  expect(unnamed.facts.payload?.compression).toBe("unknown");
});

it("notes a manifest version the references do not describe", async () => {
  const manifest = Buffer.from(im4m());
  const version = manifest.indexOf(Buffer.from([0x02, 0x01, 0x00]));
  manifest[version + 2] = 1;
  const result = await image4(manifest);
  expect(result.facts.manifest?.version).toBe("1");
  expect(result.limitations.join("\n")).toContain(
    "manifest version 1 is not 0",
  );
});

it("keeps an unreadable restore entry redacted instead of walking its value", async () => {
  const unreadable = tlv(0x16, Buffer.from([0x42, 0x80, 0x43, 0x4e]));
  const entry = sequence(
    unreadable,
    sequence(ia5("private-nonce"), octet(SAMPLE_NONCE)),
  );
  const result = await image4(
    img4(im4p(), im4m(), sequence(ia5("IM4R"), derSet(entry))),
  );
  expect(result.facts.restore_info?.properties_present).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("private-nonce");
  expect(result.limitations.join("\n")).toContain("could not be read");
});

it("does not load or retain opaque bytes it never decodes", async () => {
  // Large OCTET STRINGs are ranged, never read.
  const largeOctets = Array.from({ length: 8 }, () =>
    octet(Buffer.alloc(IMAGE4_MAX_NESTED_BYTES - 64)),
  );
  let read = 0;
  const ranged = await image4(
    manifestWithCertificates(sequence(...largeOctets)),
    (length) => {
      read += length;
    },
  );
  expect(ranged.facts.manifest?.certificate_chain_size).toBeGreaterThan(
    IMAGE4_MAX_NESTED_BYTES,
  );
  expect(read).toBeLessThan(IMAGE4_MAX_NESTED_BYTES);

  // Small constructed values are tree-parsed only up to the retained budget.
  const wrapped = Array.from(
    { length: Math.ceil(IMAGE4_MAX_RETAINED_BYTES / (64 * 1024)) + 8 },
    () => sequence(octet(Buffer.alloc(64 * 1024))),
  );
  read = 0;
  const bounded = await image4(
    manifestWithCertificates(sequence(...wrapped)),
    (length) => {
      read += length;
    },
  );
  expect(bounded.facts.manifest).not.toBeNull();
  expect(read).toBeLessThan(
    IMAGE4_MAX_RETAINED_BYTES + IMAGE4_MAX_NESTED_BYTES,
  );
});

it("keeps a stopped keybag in its slot so the payload stays encrypted", async () => {
  // A definite IM4P whose keybag is an indefinite constructed OCTET STRING
  // with more than the nested parse left in the parent.
  const indefiniteKeybag = Buffer.concat([
    Buffer.from([0x24, 0x80]),
    octet(Buffer.from("kbag")),
    Buffer.from([0x00, 0x00]),
  ]);
  const bytes = sequence(
    ia5("IM4P"),
    ia5("krnl"),
    ia5("Kernelcache"),
    octet(SAMPLE_PAYLOAD),
    indefiniteKeybag,
    octet(Buffer.alloc(IMAGE4_MAX_NESTED_BYTES + 16)),
  );
  const result = await image4(bytes);
  expect(result.facts.payload).toMatchObject({
    encrypted: true,
    keybag_count: null,
    keybag_types: null,
  });
  expect(result.entries[0]).toMatchObject({ path: "payload", encrypted: true });
  expect(result.limitations.join("\n")).toContain("indefinite length");
  expect(result.limitations.join("\n")).toContain("were not examined");
});

it("reports a manifest property body that is not a property set", async () => {
  const body = derSet(
    privateTagged(
      "MANB",
      sequence(
        ia5("MANB"),
        privateTagged("MANP", sequence(ia5("MANP"), integer(5))),
        manifestObject("ibot", property("DGST", octet(SAMPLE_DIGEST))),
      ),
    ),
  );
  const result = await image4(
    sequence(
      ia5("IM4M"),
      integer(0),
      body,
      octet(SAMPLE_SIGNATURE),
      sequence(octet(SAMPLE_CERT)),
    ),
  );
  expect(result.facts.manifest?.properties).toEqual([]);
  expect(result.facts.manifest?.objects[0]?.digest_hex).toBe(
    SAMPLE_DIGEST.toString("hex"),
  );
  expect(result.limitations.join("\n")).toContain("Unknown Image4 tag 0x02");
});

it("applies the string allowance only to text it retains", async () => {
  const unknownText = ia5("A".repeat(IMAGE4_MAX_STRING_BYTES + 1));
  const large = await image4(
    im4p({
      payload: Buffer.alloc(IMAGE4_MAX_NESTED_BYTES + 16),
      extra: [unknownText],
    }),
  );
  expect(large.facts.payload).not.toBeNull();
  expect(large.limitations.join("\n")).toContain("Unknown Image4 tag 0x16");
});

it("keeps IMG4 manifest and restore slots after an unsupported payload value", async () => {
  const result = await image4(
    sequence(ia5("IMG4"), integer(1), explicit(0, im4m()), explicit(1, im4r())),
  );
  expect(result.facts.payload).toBeNull();
  expect(result.facts.manifest).not.toBeNull();
  expect(result.facts.restore_info?.properties_present).toEqual(["BNCN"]);
  expect(result.entries.map((entry) => entry.path)).toEqual([
    "manifest.der",
    "restore-info.der",
  ]);
  expect(result.limitations.join("\n")).toContain("Unknown Image4 tag 0x02");
});

it("never reports names from inside a restore property value", async () => {
  const secret = sequence(ia5("secret-value"), octet(SAMPLE_NONCE));
  const cases = [
    // An INTEGER where the PRIVATE property's name belongs: unknown entry.
    { entry: privateTagged("BNCN", sequence(integer(1), secret)), names: [] },
    // A property that names itself IM4R is one ordinary property.
    {
      entry: privateTagged("IM4R", sequence(ia5("IM4R"), secret)),
      names: ["IM4R"],
    },
    // An unnamed SEQUENCE that is not the property SET: unknown entry.
    { entry: sequence(integer(1), secret), names: [] },
  ];
  for (const { entry, names } of cases) {
    const result = await image4(
      img4(im4p(), im4m(), sequence(ia5("IM4R"), derSet(entry))),
    );
    expect(result.facts.restore_info?.properties_present).toEqual(names);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    if (names.length === 0)
      expect(result.limitations.length).toBeGreaterThan(0);
  }
});

it("reads small fields after the retained budget is used", async () => {
  // Exhaust the retained budget completely: large children use most of it,
  // then smaller and smaller ones drain what is left below the size of the
  // two-byte value that ends the padding, so nothing later can be retained.
  const child = (encoded: number): Buffer =>
    encoded === 2
      ? sequence()
      : sequence(octet(Buffer.alloc(encoded - (encoded > 128 ? 8 : 4))));
  const padding = [
    ...Array.from(
      { length: Math.ceil(IMAGE4_MAX_RETAINED_BYTES / 65_536) + 2 },
      () => child(65_536),
    ),
    ...Array.from({ length: 70 }, () => child(1024)),
    ...Array.from({ length: 20 }, () => child(64)),
    ...Array.from({ length: 10 }, () => child(8)),
    ...Array.from({ length: 5 }, () => child(2)),
  ];
  const result = await image4(
    img4(im4p(), manifestWithCertificates(sequence(...padding)), im4r()),
  );
  expect(result.facts.restore_info?.properties_present).toEqual(["BNCN"]);
  expect(result.entries.map((entry) => entry.path)).toEqual([
    "payload",
    "manifest.der",
    "restore-info.der",
  ]);
});

it("explains a declared uncompressed size it cannot keep", async () => {
  for (const [size, text] of [
    [-1n, "is negative"],
    [2n ** 60n, "exceeds the largest exact integer"],
  ] as const) {
    const result = await image4(
      im4p({
        compression: sequence(integer(LZFSE_ALGORITHM), integer(size)),
      }),
    );
    expect(result.facts.payload?.uncompressed_size).toBeNull();
    expect(result.limitations.join("\n")).toContain(text);
  }
});

it("never reserves tree budget for a value it only ranges", async () => {
  const indefiniteRestore = Buffer.concat([
    Buffer.from([0x30, 0x80]),
    ia5("IM4R"),
    derSet(property("BNCN", octet(SAMPLE_NONCE))),
    Buffer.from([0x00, 0x00]),
  ]);
  // Size the payload so the root and IM4P wrappers together are just under
  // the retained budget: reserving their bytes would leave too little for the
  // small indefinite IM4R, which must still be tree-parsed to find its end.
  const build = (length: number): { file: Buffer; payload: Buffer } => {
    const payload = im4p({ payload: Buffer.alloc(length) });
    return { file: img4(payload, im4m(), indefiniteRestore), payload };
  };
  const probe = IMAGE4_MAX_RETAINED_BYTES / 2 - 4096;
  const sized = build(probe);
  const wrappers = sized.file.length + sized.payload.length;
  const length =
    probe + Math.floor((IMAGE4_MAX_RETAINED_BYTES - 10 - wrappers) / 2);
  const result = await image4(build(length).file);
  expect(result.facts.restore_info?.properties_present).toEqual(["BNCN"]);
  expect(result.entries.map((entry) => entry.path)).toContain(
    "restore-info.der",
  );
});

it("keeps an unreadable PRIVATE manifest entry opaque", async () => {
  const hidden = privateTagged(
    "TEST",
    sequence(
      integer(7),
      sequence(ia5("MANP"), derSet(property("CHIP", integer(0x1234)))),
    ),
  );
  const result = await image4(
    sequence(
      ia5("IM4M"),
      integer(0),
      derSet(privateTagged("MANB", sequence(ia5("MANB"), hidden))),
      octet(SAMPLE_SIGNATURE),
      sequence(octet(SAMPLE_CERT)),
    ),
  );
  expect(result.facts.manifest?.properties).toEqual([]);
  expect(result.facts.manifest?.objects).toEqual([]);
  expect(result.limitations.join("\n")).toContain("could not be read");
});

it("reports a MANB, MANP or IM4R entry with no body after its name", async () => {
  const nameOnly = (name: string): Buffer =>
    privateTagged(name, sequence(ia5(name)));
  const manp = await image4(
    sequence(
      ia5("IM4M"),
      integer(0),
      derSet(
        privateTagged(
          "MANB",
          sequence(
            ia5("MANB"),
            derSet(
              nameOnly("MANP"),
              manifestObject("ibot", property("DGST", octet(SAMPLE_DIGEST))),
            ),
          ),
        ),
      ),
      octet(SAMPLE_SIGNATURE),
      sequence(octet(SAMPLE_CERT)),
    ),
  );
  expect(manp.facts.manifest?.objects[0]?.name).toBe("ibot");
  expect(manp.limitations.join("\n")).toContain("MANP entry");

  const manb = await image4(
    sequence(
      ia5("IM4M"),
      integer(0),
      derSet(nameOnly("MANB")),
      octet(SAMPLE_SIGNATURE),
      sequence(octet(SAMPLE_CERT)),
    ),
  );
  expect(manb.limitations.join("\n")).toContain("MANB entry");

  const restore = await image4(img4(im4p(), im4m(), sequence(ia5("IM4R"))));
  expect(restore.facts.restore_info?.properties_present).toEqual([]);
  expect(restore.limitations.join("\n")).toContain("IM4R entry");
});

it("reports a manifest value that names itself but is not an entry SEQUENCE", async () => {
  const contextTagged = tlv(
    0xa3,
    Buffer.concat([ia5("MANP"), derSet(property("CHIP", integer(0x1234)))]),
  );
  const result = await image4(
    sequence(
      ia5("IM4M"),
      integer(0),
      derSet(
        privateTagged(
          "MANB",
          sequence(
            ia5("MANB"),
            derSet(
              contextTagged,
              manifestObject("ibot", property("DGST", octet(SAMPLE_DIGEST))),
            ),
          ),
        ),
      ),
      octet(SAMPLE_SIGNATURE),
      sequence(octet(SAMPLE_CERT)),
    ),
  );
  expect(result.facts.manifest?.properties).toEqual([]);
  expect(result.facts.manifest?.objects[0]?.name).toBe("ibot");
  expect(result.limitations.join("\n")).toContain("Unknown Image4 tag 0xa3");
});

it("keeps IMG4 restore info after an unsupported manifest slot", async () => {
  for (const manifestSlot of [
    integer(1),
    // A primitive [0] in the manifest position.
    tlv(0x80, Buffer.from([0x01])),
  ]) {
    const result = await image4(
      sequence(ia5("IMG4"), im4p(), manifestSlot, explicit(1, im4r())),
    );
    expect(result.facts.manifest).toBeNull();
    expect(result.facts.restore_info?.properties_present).toEqual(["BNCN"]);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "payload",
      "restore-info.der",
    ]);
    expect(result.limitations.join("\n")).toContain("Unknown Image4 tag");
  }
  // A restore value directly after the payload still fills its own slot.
  const direct = await image4(
    sequence(ia5("IMG4"), im4p(), explicit(1, im4r())),
  );
  expect(direct.facts.restore_info?.properties_present).toEqual(["BNCN"]);
  expect(direct.limitations).toEqual([]);
});
