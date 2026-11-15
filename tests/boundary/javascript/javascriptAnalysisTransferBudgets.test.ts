import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptSemantics } from "../../../src/domain/javascript/javascriptSemanticAnalysis.js";
import { projectJavaScriptModuleSemantics } from "../../../src/domain/javascript/javascriptModuleSemanticIr.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { completeJavaScriptAnalysisSteps } from "../../../src/application/javascript/JavaScriptAnalysisControl.js";
import { projectJavaScriptSemanticFileSteps } from "../../../src/application/javascript/JavaScriptSemanticGraphBuilder.js";
import {
  javaScriptTransferByteBudget,
  measureJavaScriptModuleTransfer,
  writeJavaScriptAnalysisTransfer,
  readJavaScriptAnalysisTransfer,
} from "../../../src/javascript/analysis/JavaScriptAnalysisTransfer.js";

it("allows larger streamed transfers only with corresponding parent capacity", () => {
  const mib = 1024 * 1024;
  expect(javaScriptTransferByteBudget(0)).toBe(512 * mib);
  expect(javaScriptTransferByteBudget(4096 * mib)).toBe(512 * mib);
  expect(javaScriptTransferByteBudget(12288 * mib)).toBe(1536 * mib);
  expect(javaScriptTransferByteBudget(32768 * mib)).toBe(2048 * mib);
});

it("enforces the offered complete-file byte budget while preserving authenticated round trips", async () => {
  const root = await createTestTempDirectory("rea-js-transfer-budget-");
  const text = "export function add(value) { return value + 1; }";
  const file: JavaScriptArtifactFile = {
    path: "app.mjs",
    sha256: createHash("sha256").update(text).digest("hex"),
    container_sha256: "a".repeat(64),
    bytes: Buffer.byteLength(text),
    inventory_artifact_id: "fixture-source",
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: text },
  };
  const ir = analyzeJavaScriptSemantics(text);
  const module = projectJavaScriptModuleSemantics(ir);
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(file, ir, { nodes: 100, unknowns: 100 }),
  );
  const observed = await writeJavaScriptAnalysisTransfer(
    join(root, "observed"),
    module,
    projection,
  );
  const measured = measureJavaScriptModuleTransfer(module);
  expect(measured).toMatchObject({
    bytes: observed.module_bytes,
    records: observed.module_records,
  });
  expect(measureJavaScriptModuleTransfer(module, measured.bytes)).toEqual(
    measured,
  );
  expect(() =>
    measureJavaScriptModuleTransfer(module, measured.bytes - 1),
  ).toThrowError(
    expect.objectContaining({
      resource: "transport",
      reportedLimits: expect.objectContaining({
        transfer_file_bytes: measured.bytes - 1,
      }),
    }),
  );
  expect(() =>
    measureJavaScriptModuleTransfer(module, 2 ** 31 + 1),
  ).toThrowError(RangeError);
  const exactPath = join(root, "exact");
  const exact = await writeJavaScriptAnalysisTransfer(
    exactPath,
    module,
    projection,
    observed.bytes,
  );
  expect(exact).toEqual(observed);
  expect(await readJavaScriptAnalysisTransfer(exactPath, exact, file)).toEqual({
    module,
    projection,
  });
  await expect(
    writeJavaScriptAnalysisTransfer(
      join(root, "short"),
      module,
      projection,
      observed.bytes - 1,
    ),
  ).rejects.toMatchObject({
    resource: "transport",
    reportedLimits: { transfer_file_bytes: observed.bytes - 1 },
  });
  await expect(
    writeJavaScriptAnalysisTransfer(
      join(root, "oversized"),
      module,
      projection,
      2 ** 31 + 1,
    ),
  ).rejects.toBeInstanceOf(RangeError);
});

it("rejects authenticated worker rows beyond the offered node or unknown capacity", async () => {
  const root = await createTestTempDirectory("rea-js-transfer-capacity-");
  const text = "globalThis.u.p(globalThis.v[k]);";
  const file: JavaScriptArtifactFile = {
    path: "app.js",
    sha256: createHash("sha256").update(text).digest("hex"),
    container_sha256: "a".repeat(64),
    bytes: Buffer.byteLength(text),
    inventory_artifact_id: "fixture-source",
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: text },
  };
  const ir = analyzeJavaScriptSemantics(text);
  const projection = await completeJavaScriptAnalysisSteps(
    projectJavaScriptSemanticFileSteps(file, ir, { nodes: 100, unknowns: 100 }),
  );
  expect(projection.unknowns.length).toBeGreaterThan(1);
  const path = join(root, "records");
  const descriptor = await writeJavaScriptAnalysisTransfer(
    path,
    projectJavaScriptModuleSemantics(ir),
    projection,
  );
  await expect(
    readJavaScriptAnalysisTransfer(path, descriptor, file, undefined, {
      nodes: 100,
      unknowns: 1,
    }),
  ).rejects.toThrow("unknowns exceed the offered capacity");
  await expect(
    readJavaScriptAnalysisTransfer(path, descriptor, file, undefined, {
      nodes: 1,
      unknowns: 100,
    }),
  ).rejects.toThrow("nodes exceed the offered capacity");
});

it("authenticates physical transfer bytes and refuses malformed UTF-8 without replacing source facts", async () => {
  const root = await createTestTempDirectory("rea-js-transfer-utf8-");
  const graph = `${JSON.stringify({ kind: "projection-header", value: { roots: [], nodesTruncated: false } })}\n`;
  const moduleRecord = (limitation: string) =>
    `${JSON.stringify({
      kind: "module-header",
      value: {
        coverage: { status: "complete", omittedCount: 0 },
        limitations: [limitation],
      },
    })}\n`;
  const prefixBytes =
    Buffer.byteLength(graph) + moduleRecord("MARK").indexOf("MARK");
  const limitation = `${"a".repeat(65535 - prefixBytes)}😀�`;
  const module = moduleRecord(limitation);
  const valid = Buffer.from(graph + module);
  expect(valid.indexOf(Buffer.from("😀"))).toBe(65535);
  const descriptor = {
    bytes: valid.length,
    sha256: createHash("sha256").update(valid).digest("hex"),
    records: 2,
    module_bytes: Buffer.byteLength(module),
    module_records: 1,
    graph_bytes: Buffer.byteLength(graph),
    graph_records: 1,
  };
  const path = join(root, "records");
  const source = { path: "app.mjs", sha256: "a".repeat(64) };
  await writeFile(path, valid);
  expect(
    (await readJavaScriptAnalysisTransfer(path, descriptor, source)).module
      .limitations,
  ).toEqual([limitation]);
  const malformed = Buffer.from(valid);
  // This incomplete four-byte sequence becomes one three-byte replacement
  // under permissive decoding, so a decoded-text digest can conceal the change.
  Buffer.from([0xf0, 0x90, 0x80]).copy(
    malformed,
    malformed.indexOf(Buffer.from("�")),
  );
  const physicalDigest = createHash("sha256").update(malformed).digest("hex");
  expect(physicalDigest).not.toBe(descriptor.sha256);
  await writeFile(path, malformed);
  for (const sha256 of [descriptor.sha256, physicalDigest]) {
    await expect(
      readJavaScriptAnalysisTransfer(
        path,
        { ...descriptor, sha256 },
        source,
      ).then(() => "accepted"),
    ).rejects.toMatchObject({ code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  }
});
