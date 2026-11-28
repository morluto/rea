import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { verifySolidityMetadataInputSchema } from "../domain/evm/solidityMetadataBinding.js";
import { ipfsFileMultihash } from "./IpfsFileHash.js";
import { SolidityMetadataBindingProvider } from "./SolidityMetadataBindingProvider.js";

const METADATA = '{"language":"Solidity"}';

/** Bytecode ending in a CBOR map {"ipfs": <multihash>} and its length. */
const bytecodeCommittingTo = (content: string) => {
  const hash = ipfsFileMultihash(Buffer.from(content));
  if (hash === undefined) throw new Error("fixture too large");
  const cbor = Buffer.concat([Buffer.from("a164697066735822", "hex"), hash]);
  return Buffer.concat([
    Buffer.from("00", "hex"),
    cbor,
    Buffer.from([0, cbor.length]),
  ]);
};

const files = async (bytecode: Uint8Array | string, metadata: string) => {
  const root = await createTestTempDirectory("rea-solidity-binding-");
  const path = join(root, "runtime.bin");
  const metadata_path = join(root, "metadata.json");
  await writeFile(path, bytecode);
  await writeFile(metadata_path, metadata);
  return { path, encoding: "raw", metadata_path };
};

const verify = async (input: Record<string, unknown>, signal?: AbortSignal) => {
  const provider = new SolidityMetadataBindingProvider();
  try {
    return await provider.inspect(
      verifySolidityMetadataInputSchema.parse(input),
      signal === undefined ? undefined : { signal },
    );
  } finally {
    await provider.close();
  }
};

const sha256 = (content: string | Uint8Array) =>
  createHash("sha256").update(content).digest("hex");

describe("verify_solidity_metadata", () => {
  it.each([
    ["match", METADATA],
    ["mismatch", `${METADATA}\n`],
  ])("reports %s for the exact supplied bytes", async (status, supplied) => {
    const result = await verify(
      await files(bytecodeCommittingTo(METADATA), supplied),
    );
    expect(result.ok && result.value).toMatchObject({
      metadata_file: { sha256: sha256(supplied) },
      trailer: { status: "decoded" },
      binding: { status, scheme: "ipfs" },
    });
  });

  it("stays unverified without a trailer", async () => {
    const result = await verify(await files(Buffer.from([0]), METADATA));
    expect(result.ok && result.value.binding).toMatchObject({
      status: "unverified",
      reason: "no_decoded_trailer",
    });
  });

  it("returns typed resource and cancellation failures", async () => {
    const input = await files(bytecodeCommittingTo(METADATA), METADATA);
    const limited = await verify({ ...input, max_metadata_bytes: 3 });
    expect(!limited.ok && limited.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      limit: {
        parameter: "max_metadata_bytes",
        required_value: METADATA.length,
      },
    });
    const cancelled = await verify(input, AbortSignal.abort());
    expect(!cancelled.ok && cancelled.error).toMatchObject({
      _tag: "AnalysisCancelledError",
    });
  });

  it("keeps the read bytecode and names the failing metadata field", async () => {
    const input = await files(bytecodeCommittingTo(METADATA), METADATA);
    const result = await verify({
      ...input,
      metadata_path: "/rea-missing/metadata.json",
    });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.partialObservation).toMatchObject({
      kind: "solidity-metadata-files",
      files: [{ path: input.path }],
    });
    expect(projectAnalysisError(result.error).details).toMatchObject({
      issues: [{ path: ["metadata_path"] }],
    });
  });

  it("keeps the identity of malformed hex", async () => {
    const input = await files("0x0", METADATA);
    const result = await verify({ ...input, encoding: "hex" });
    expect(!result.ok && result.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
      partialObservation: { path: input.path, sha256: sha256("0x0") },
    });
  });
});
