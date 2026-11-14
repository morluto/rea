import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CanonicalizeService } from "../application/canonicalize/CanonicalizeService.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { canonicalizeArtifactSchema } from "../domain/canonicalize/canonicalizeArtifact.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { CanonicalizeProvider } from "./CanonicalizeProvider.js";

const lebU32 = (value: number): Buffer => {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return Buffer.from(out);
};
const section = (id: number, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([id]), lebU32(payload.length), payload]);
const customSection = (name: string, content: Buffer): Buffer => {
  const nameBytes = Buffer.from(name, "utf8");
  return section(
    0,
    Buffer.concat([lebU32(nameBytes.length), nameBytes, content]),
  );
};
const typePayload = Buffer.from([0x01, 0x60, 0x00, 0x00]);
const decoyWasm = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    section(1, typePayload),
    customSection("bla.enclave.manifest", Buffer.alloc(8192, 0x41)),
  ]);

const run = async (
  path: string,
  input: { readonly max_file_bytes?: number } = {},
) => {
  const service = new CanonicalizeService(new CanonicalizeProvider());
  try {
    return await service.canonicalize({ path, ...input });
  } finally {
    await service.close();
  }
};

describe("canonicalize provider over real files", () => {
  it("canonicalizes a real WASM module and never mutates it", async () => {
    const root = await createTestTempDirectory("rea-canonicalize-wasm-");
    const path = join(root, "core.wasm");
    const bytes = decoyWasm();
    await writeFile(path, bytes);
    const result = await run(path);
    if (!result.ok) throw result.error;
    const facts = canonicalizeArtifactSchema.parse(
      result.value.normalized_result,
    );
    expect(facts.detected_format).toBe("wasm");
    expect(facts.artifact.bytes).toBe(bytes.length);
    // Behavior-relevant core section retained and byte-exact.
    const type = facts.core.find((fact) => fact.name === "type");
    expect(type).toBeDefined();
    const slice = bytes.subarray(
      type!.location!.offset,
      type!.location!.offset + type!.location!.bytes,
    );
    expect(Buffer.compare(slice, typePayload)).toBe(0);
    // Injected custom-section padding collapsed, not retained verbatim.
    expect(
      facts.collapsed.some((fact) => fact.name === "bla.enclave.manifest"),
    ).toBe(true);
    expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  });

  it("rejects a nonexistent file as invalid input", async () => {
    const root = await createTestTempDirectory("rea-canonicalize-missing-");
    const result = await run(join(root, "absent.wasm"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  });

  it("refuses an input beyond the caller-selected read budget", async () => {
    const root = await createTestTempDirectory("rea-canonicalize-oversize-");
    const path = join(root, "big.bin");
    await writeFile(path, Buffer.alloc(512, 0x00));
    const result = await run(path, { max_file_bytes: 64 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  });
});
