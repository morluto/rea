import { bufferByteSource } from "../../../src/domain/byteSource.js";
import type { InspectPeCertificatesInput } from "../../../src/domain/native/peCertificates.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import { parsePeCertificatesFromHandle } from "../../../src/native/pe/PeCertificateParser.js";

export const parsePeCertificateFixture = (
  bytes: Buffer,
  input: InspectPeCertificatesInput,
) => {
  const sha256 = sha256Hex(bytes);
  return parsePeCertificatesFromHandle(
    { ...bufferByteSource(bytes), sha256 },
    { path: input.path, bytes: bytes.length, sha256 },
    input,
  );
};
