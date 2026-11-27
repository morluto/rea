import { createHash } from "node:crypto";

const machines = { x64: 0x8664, arm64: 0xaa64 } as const;

/** Inert PE32+ identity bytes, never an executable addon or native authority. */
export const windowsNativeArtifactFixture = (
  architecture: keyof typeof machines = "x64",
) => {
  const peOffset = 64;
  const optionalHeaderOffset = peOffset + 4 + 20;
  const optionalHeaderSize = 64;
  const bytes = Buffer.alloc(optionalHeaderOffset + optionalHeaderSize);
  bytes.write("MZ");
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write("PE\0\0", peOffset, "ascii");
  bytes.writeUInt16LE(machines[architecture], peOffset + 4);
  bytes.writeUInt16LE(optionalHeaderSize, peOffset + 4 + 16);
  bytes.writeUInt16LE(0x20b, optionalHeaderOffset);
  // Keep the expected wire identity independent of the production producer.
  const manifest = {
    packageVersion: "1.0.0",
    platform: "win32",
    architecture,
    abiVersion: 1,
    nodeApiVersion: 8,
    artifact: `rea-windows-${architecture}.node`,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { bytes, manifest };
};
