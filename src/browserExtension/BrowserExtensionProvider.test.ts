import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { BrowserExtensionProvider } from "./BrowserExtensionProvider.js";
import { BrowserExtensionService } from "../application/browserExtension/BrowserExtensionService.js";

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
  return Buffer.concat([
    local,
    central,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
};

describe("BrowserExtensionProvider", () => {
  it("reads an admitted CRX and keeps the signature unverified", async () => {
    const root = await createTestTempDirectory("rea-browser-extension-");
    const manifest = Buffer.from(
      JSON.stringify({
        manifest_version: 3,
        name: "Fixture",
        version: "1.0.0",
        permissions: ["storage"],
        background: { service_worker: "background.js" },
      }),
    );
    const zip = storedZip("manifest.json", manifest);
    const bytes = Buffer.concat([
      Buffer.from("Cr24"),
      u32(3),
      u32(1),
      Buffer.from([0]),
      zip,
    ]);
    const path = join(root, "fixture.crx");
    await writeFile(path, bytes);
    const provider = new BrowserExtensionProvider();
    try {
      const result = await provider.inspect({
        path,
        max_file_bytes: 67108864,
        max_manifest_bytes: 2097152,
        max_entries: 20,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.format).toBe("crx3");
      expect(result.value.artifact.sha256).toHaveLength(64);
      expect(result.value.manifest.permissions).toEqual(["storage"]);
      expect(result.value.limitations.join(" ")).toContain("not verified");
      const evidence = await new BrowserExtensionService(provider).inspect({
        path,
      });
      expect(evidence.ok, JSON.stringify(evidence)).toBe(true);
      if (!evidence.ok) return;
      expect(evidence.value.subject).toMatchObject({
        identity: { format: "file" },
      });
      expect(evidence.value.operation).toBe("inspect_browser_extension");
    } finally {
      await provider.close();
    }
  });

  it("inspects repeated placeholders within the manifest byte budget", async () => {
    const root = await createTestTempDirectory("rea-browser-extension-repeat-");
    const path = join(root, "manifest.json");
    const bytes = Buffer.from(
      JSON.stringify({
        manifest_version: 3,
        custom_key: "__MSG_A__ ".repeat(200000),
      }),
    );
    expect(bytes.length).toBeLessThan(2097152);
    await writeFile(path, bytes);
    const service = new BrowserExtensionService(new BrowserExtensionProvider());
    try {
      const result = await service.inspect({ path });
      if (!result.ok) throw result.error;
      expect(result.value.operation).toBe("inspect_browser_extension");
      expect(result.value.normalized_result).toMatchObject({
        format: "unpacked",
        manifest: { message_keys: ["A"] },
      });
      expect(result.value.limitations.join(" ")).toContain("left unresolved");
    } finally {
      await service.close();
    }
  });

  it("reports a truncated ZIP as a format failure, not a file-access failure", async () => {
    const root = await createTestTempDirectory("rea-browser-extension-badzip-");
    const path = join(root, "broken.zip");
    await writeFile(path, Buffer.from("PK\x03\x04"));
    const provider = new BrowserExtensionProvider();
    try {
      const result = await provider.inspect({
        path,
        max_file_bytes: 67108864,
        max_manifest_bytes: 2097152,
        max_entries: 20,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error._tag).toBe("AnalysisInputError");
    } finally {
      await provider.close();
    }
  });

  it("does not tell a fixed manifest limit to raise max_entries", async () => {
    const root = await createTestTempDirectory("rea-browser-extension-limit-");
    const scripts = Array.from({ length: 1001 }, () => ({
      matches: ["https://example.com/*"],
    }));
    const zip = storedZip(
      "manifest.json",
      Buffer.from(
        JSON.stringify({ manifest_version: 3, content_scripts: scripts }),
      ),
    );
    const path = join(root, "too-many.zip");
    await writeFile(path, zip);
    const provider = new BrowserExtensionProvider();
    try {
      const result = await provider.inspect({
        path,
        max_file_bytes: 67108864,
        max_manifest_bytes: 2097152,
        max_entries: 20,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
      expect(result.error).toMatchObject({
        remediationAction: expect.not.stringContaining("max_entries"),
      });
    } finally {
      await provider.close();
    }
  });
});
