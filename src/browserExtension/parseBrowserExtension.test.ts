import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { ParseFailureError } from "../domain/parseFailure.js";
import {
  BROWSER_EXTENSION_FORMAT,
  parseBrowserExtension,
} from "./parseBrowserExtension.js";

const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};
const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

const storedZip = (name: string, data: Buffer): Buffer => {
  const nameBytes = Buffer.from(name);
  const checksum = crc32(data) >>> 0;
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(checksum),
    u32(data.length),
    u32(data.length),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
    data,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(checksum),
    u32(data.length),
    u32(data.length),
    u16(nameBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    nameBytes,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
};

const storedZipEntries = (
  files: readonly (readonly [string, Buffer])[],
): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    Buffer.concat(locals),
    central,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
};

const crx3 = (zip: Buffer, header = Buffer.from([0x0a])): Buffer =>
  Buffer.concat([Buffer.from("Cr24"), u32(3), u32(header.length), header, zip]);

const crx2 = (zip: Buffer, key: Buffer, signature: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from("Cr24"),
    u32(2),
    u32(key.length),
    u32(signature.length),
    key,
    signature,
    zip,
  ]);

const manifest = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

const input = {
  path: "/artifacts/extension.crx",
  max_file_bytes: 67108864,
  max_manifest_bytes: 2097152,
  max_entries: 20000,
};

const inspect = (bytes: Buffer, path = input.path) =>
  parseBrowserExtension(
    bytes,
    { path, sha256: "a".repeat(64), bytes: bytes.length },
    { ...input, path },
  );

const sample = {
  manifest_version: 3,
  name: "__MSG_extName__",
  version: "1.2.3",
  description: "Reads the active tab",
  default_locale: "en",
  permissions: ["storage", "nativeMessaging"],
  host_permissions: ["https://example.com/*"],
  optional_host_permissions: ["https://optional.example/*"],
  background: { service_worker: "background.js", type: "module" },
  action: { default_title: "__MSG_action__" },
  browser_specific_settings: {
    gecko: { id: "addon@example", strict_min_version: "115.0" },
  },
  applications: { gecko: { id: "legacy@example" } },
  content_scripts: [
    {
      matches: ["https://example.com/*"],
      js: ["content.js"],
      css: ["content.css"],
      run_at: "document_start",
      world: "ISOLATED",
      all_frames: false,
    },
  ],
  content_security_policy: {
    extension_pages: "script-src 'self'",
    sandbox: "sandbox allow-scripts",
  },
  side_panel: { default_path: "side.html" },
  commands: { "open-panel": { suggested_key: { default: "Ctrl+Shift+Y" } } },
  web_accessible_resources: [
    { resources: ["page.html"], matches: ["https://example.com/*"] },
  ],
  externally_connectable: { matches: ["https://example.com/*"] },
  incognito: "split",
  custom_key: true,
};

describe("parseBrowserExtension", () => {
  it("reads a CRX3 manifest without treating the signature as verified", async () => {
    const zip = storedZip("manifest.json", manifest(sample));
    const header = Buffer.from([1, 2, 3, 4]);
    const bytes = crx3(zip, header);
    const report = await inspect(bytes);
    expect(report.format).toBe("crx3");
    expect(report.container).toMatchObject({
      zip_offset: 12 + header.length,
      crx_version: 3,
      public_key_bytes: null,
      signature_bytes: null,
    });
    expect(report.manifest).toMatchObject({
      manifest_version: 3,
      name: "__MSG_extName__",
      version: "1.2.3",
      permissions: ["storage", "nativeMessaging"],
      host_permissions: ["https://example.com/*"],
      message_keys: ["extName", "action"],
      background: { kind: "service_worker", service_worker: "background.js" },
      gecko: {
        id: "addon@example",
        id_source: "browser_specific_settings",
        conflicting_id: "legacy@example",
      },
      side_panel: true,
      commands: ["open-panel"],
      unknown_keys: ["custom_key"],
    });
    expect(report.limitations.join("\n")).toContain(
      "signature was not verified",
    );
    expect(report.limitations.join("\n")).toContain("left unresolved");
  });

  it("measures a CRX2 key and signature without reading them as trust", async () => {
    const zip = storedZip(
      "manifest.json",
      manifest({ manifest_version: 2, name: "Legacy", version: "0.1" }),
    );
    const bytes = crx2(zip, Buffer.from("key-material"), Buffer.from("sig"));
    const report = await inspect(bytes, "/artifacts/legacy.crx");
    expect(report.format).toBe("crx2");
    expect(report.container).toMatchObject({
      public_key_bytes: Buffer.from("key-material").length,
      signature_bytes: 3,
      zip_offset: 16 + Buffer.from("key-material").length + 3,
    });
    expect(report.manifest.manifest_version).toBe(2);
  });

  it("accepts an XPI-style ZIP and an unpacked manifest.json", async () => {
    const zip = storedZip("manifest.json", manifest(sample));
    const zipped = await inspect(zip, "/artifacts/addon.xpi");
    expect(zipped.format).toBe("zip");
    expect(zipped.container?.zip_offset).toBe(0);
    const raw = manifest(sample);
    const unpacked = await inspect(raw, "/work/unpacked/manifest.json");
    expect(unpacked.format).toBe("unpacked");
    expect(unpacked.container).toBeNull();
    expect(unpacked.manifest.permissions).toEqual(sample.permissions);
  });

  it("refuses a nested manifest, a non-package file, and an over-budget entry list", async () => {
    const nested = storedZip("addon/manifest.json", manifest(sample));
    await expect(inspect(nested)).rejects.toThrow(/no root manifest.json/);
    await expect(
      inspect(Buffer.from("not-a-package"), "/tmp/notes.txt"),
    ).rejects.toBeInstanceOf(ParseFailureError);
    const zip = storedZip("manifest.json", manifest({ manifest_version: 3 }));
    await expect(
      parseBrowserExtension(
        zip,
        { path: input.path, sha256: "b".repeat(64), bytes: zip.length },
        { ...input, max_entries: 0 },
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        format: BROWSER_EXTENSION_FORMAT,
        limit: { name: "max_entries", maximum: 0, required: 1 },
      },
    });
  });

  it("rejects duplicate root manifests, oversized unpacked manifests, silent truncation, and short object policies", async () => {
    const first = manifest({
      manifest_version: 3,
      name: "One",
      permissions: ["storage"],
    });
    const second = manifest({
      manifest_version: 3,
      name: "Two",
      permissions: ["tabs"],
    });
    const duplicate = storedZipEntries([
      ["manifest.json", first],
      ["manifest.json", second],
    ]);
    await expect(inspect(duplicate)).rejects.toThrow(
      /multiple root manifest.json/,
    );
    const raw = manifest({ manifest_version: 3, name: "Big" });
    await expect(
      parseBrowserExtension(
        raw,
        {
          path: "/work/manifest.json",
          sha256: "c".repeat(64),
          bytes: raw.length,
        },
        { ...input, path: "/work/manifest.json", max_manifest_bytes: 8 },
      ),
    ).rejects.toMatchObject({
      failure: { kind: "limit", limit: { name: "max_manifest_bytes" } },
    });
    const keys = Array.from(
      { length: 65 },
      (_, index) => `__MSG_k${String(index)}__`,
    ).join(" ");
    await expect(
      inspect(
        storedZip(
          "manifest.json",
          manifest({ manifest_version: 3, description: keys }),
        ),
        "/work/manifest.json",
      ),
    ).rejects.toMatchObject({
      failure: { kind: "limit", limit: { name: "fixed:message_keys" } },
    });
    const policy = "script-src 'self' ".padEnd(9000, "a");
    const report = await inspect(
      storedZip(
        "manifest.json",
        manifest({
          manifest_version: 3,
          content_security_policy: { extension_pages: policy },
        }),
      ),
    );
    expect(report.manifest.content_security_policy).toMatchObject({
      kind: "object",
      extension_pages: policy,
    });
  });
});

describe("parseBrowserExtension message placeholders", () => {
  it.each(["action", "browser_action", "page_action"])(
    "still validates %s titles after collecting placeholders generically",
    async (key) => {
      const raw = manifest({
        manifest_version: 3,
        [key]: { default_title: 42 },
      });
      await expect(inspect(raw, "/work/manifest.json")).rejects.toMatchObject({
        failure: { kind: "malformed" },
        message: `${key}.default_title is not a string.`,
      });
    },
  );

  it.each([64, 65])(
    "bounds distinct keys across nested strings at %i",
    async (count) => {
      const keys = Array.from(
        { length: count },
        (_, index) => `k${String(index)}`,
      );
      const raw = manifest({
        manifest_version: 3,
        custom_key: keys.map((key) => ({
          value: `__MSG_${key}__ __MSG_${key}__`,
        })),
      });
      const result = inspect(raw, "/work/manifest.json");
      if (count === 64)
        expect((await result).manifest.message_keys).toEqual(keys);
      else
        await expect(result).rejects.toMatchObject({
          failure: {
            kind: "limit",
            limit: { name: "fixed:message_keys", maximum: 64, required: 65 },
          },
        });
    },
  );

  it("collects placeholders from every manifest string", async () => {
    const report = await inspect(
      storedZip(
        "manifest.json",
        manifest({
          manifest_version: 3,
          name: "Example",
          commands: { open: { description: "__MSG_openDescription__" } },
          custom_key: { nested: ["__MSG_nestedKey__"] },
        }),
      ),
    );
    expect(report.manifest.message_keys).toEqual([
      "openDescription",
      "nestedKey",
    ]);
    expect(report.limitations.join("\n")).toContain("left unresolved");
  });
});
