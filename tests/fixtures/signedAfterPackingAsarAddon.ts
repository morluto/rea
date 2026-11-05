import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";

import {
  peCertificateFixture,
  pkcs7SignedDataFixture,
} from "../../src/native/pe/PeCertificates.fixture.js";
import { rebuildPeBytesWithoutCertificateTable } from "../../src/native/pe/PeUnsignedDigest.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** ASAR whose unpacked PE companion was Authenticode-signed after packing. */
export const createSignedAfterPackingAsarAddon = async () => {
  const root = await createTestTempDirectory("rea-signed-after-packing-asar-");
  const source = join(root, "source");
  const archive = join(root, "app.asar");
  const addon = "node_modules/device/binding.node";
  const addonPath = join(source, "node_modules", "device", "binding.node");
  const signed = peCertificateFixture(false, pkcs7SignedDataFixture());
  signed.writeUInt32LE(0xfeedface, 0x98 + 64);
  const rebuilt = rebuildPeBytesWithoutCertificateTable(signed);
  if (rebuilt === null) throw new Error("expected unsigned PE reconstruction");
  const original = rebuilt.bytes;
  await mkdir(join(source, "node_modules", "device"), { recursive: true });
  await writeFile(join(source, "main.js"), "module.exports = 'observed';\n");
  await writeFile(addonPath, original);
  await createPackageWithOptions(source, archive, { unpack: "*.node" });
  await writeFile(
    join(`${archive}.unpacked`, "node_modules", "device", "binding.node"),
    signed,
  );
  return {
    root,
    archive,
    addon,
    original,
    signed,
    declaredSha256: createHash("sha256").update(original).digest("hex"),
    observedSha256: createHash("sha256").update(signed).digest("hex"),
  };
};
