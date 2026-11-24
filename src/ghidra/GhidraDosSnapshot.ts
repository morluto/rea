import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  readArtifactFileChunks,
  ArtifactReaderFailure,
} from "../resources/index.js";
import {
  dosMzDeclaredImageByteLength,
  readDosMzDeclarations,
  parseDeclaredMzHeaderEvidence,
  withMzWindowsHeaderSignature,
} from "../domain/dosMz.js";
import { err } from "../domain/result.js";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import {
  attestGhidraDosLoadImage,
  prepareGhidraDosLoadImage,
} from "./GhidraLoadImageValues.js";

const cancelled = (reason: unknown): Error =>
  new ArtifactReaderFailure("cancelled", "DOS snapshot read cancelled", {
    cause: reason,
  });

/** The caller owns admission, state validation and descriptor finalization. */
export const attestGhidraDosSnapshot = async (
  handle: FileHandle,
  fileBytes: number,
  path: string,
  targetSha256: string,
  observations: NativeLoadImageObservation,
  signal?: AbortSignal,
) => {
  const headerBytes = Math.min(fileBytes, 64);
  const header = Buffer.allocUnsafe(headerBytes);
  let headerRead = 0;
  while (headerRead < headerBytes) {
    if (signal?.aborted) throw cancelled(signal.reason);
    const { bytesRead } = await handle.read(
      header,
      headerRead,
      headerBytes - headerRead,
      headerRead,
    );
    if (signal?.aborted) throw cancelled(signal.reason);
    if (bytesRead === 0) throw new RegularFileChangedError(path);
    headerRead += bytesRead;
  }
  const declarations = readDosMzDeclarations(header);
  if (!declarations.ok) return declarations;
  const extent = dosMzDeclaredImageByteLength(declarations.value);
  if (!extent.ok) return extent;
  if (extent.value > fileBytes) return err("truncated DOS MZ load module");
  // Retain the complete initialized image and the Windows-pointer header only.
  // The unsigned 16-bit page count bounds this allocation independently of overlays.
  const captureBytes = Math.max(headerBytes, extent.value);
  const prefix = Buffer.allocUnsafe(captureBytes);
  header.copy(prefix);
  let captured = header.length;
  if (captured < captureBytes) {
    for await (const chunk of readArtifactFileChunks(handle, {
      start: captured,
      end: captureBytes - 1,
      signal,
    })) {
      chunk.copy(prefix, captured);
      captured += chunk.length;
    }
  }
  if (captured !== captureBytes) throw new RegularFileChangedError(path);
  let evidence = parseDeclaredMzHeaderEvidence(prefix, fileBytes, declarations);
  const { windowsHeader } = evidence;
  let signature:
    | { readonly offset: number; readonly bytes: Buffer }
    | undefined;
  if (windowsHeader.state === "signature-needed") {
    const size = Math.min(4, fileBytes - windowsHeader.offset);
    const signatureBytes = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      if (signal?.aborted) throw cancelled(signal.reason);
      const { bytesRead } = await handle.read(
        signatureBytes,
        read,
        size - read,
        windowsHeader.offset + read,
      );
      if (bytesRead === 0) throw new RegularFileChangedError(path);
      read += bytesRead;
    }
    signature = {
      offset: windowsHeader.offset,
      bytes: signatureBytes,
    };
  }
  if (signature !== undefined)
    evidence = withMzWindowsHeaderSignature(
      prefix,
      fileBytes,
      evidence,
      signature,
    );
  const prepared = prepareGhidraDosLoadImage(prefix, evidence);
  if (!prepared.ok) return prepared;
  const originalHash = createHash("sha256").update(prefix);
  const image = prepared.value;
  const expected =
    image.kind === "exact"
      ? {
          kind: image.kind,
          image,
          hash: createHash("sha256")
            .update(image.modified)
            .update(prefix.subarray(image.header.imageBytes)),
        }
      : image;
  let read = prefix.length;
  if (read < fileBytes) {
    for await (const chunk of readArtifactFileChunks(handle, {
      start: read,
      end: fileBytes - 1,
      signal,
    })) {
      originalHash.update(chunk);
      if (expected.kind === "exact") expected.hash.update(chunk);
      read += chunk.length;
    }
  }
  if (read !== fileBytes) throw new RegularFileChangedError(path);
  return attestGhidraDosLoadImage(
    {
      sha256: originalHash.digest("hex"),
      fileBytes,
      image:
        expected.kind === "exact"
          ? { ...expected.image, modifiedSha256: expected.hash.digest("hex") }
          : expected,
    },
    targetSha256,
    observations,
  );
};
