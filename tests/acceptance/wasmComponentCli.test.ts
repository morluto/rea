import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  gatedFeatureComponent,
  nestedComponent,
  representativeComponent,
  withPreamble,
} from "../../src/wasm/WasmComponentBinary.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "decodes a component's interface and canonical relationships through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-wasm-component-cli-");
    const path = join(root, "component.wasm");
    const bytes = representativeComponent();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-wasm-component", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_wasm_component").outputSchema.parse(
      result.json,
    );
    const report = evidence.normalized_result;
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.decoder).toMatchObject({
      id: "wasm-component-binary",
      admitted_version: 13,
      admitted_layer: 1,
    });
    expect(report.components[0]?.imports.map(({ name }) => name)).toEqual([
      "log",
      "wasi:fs/types@0.2.0",
    ]);
    expect(report.components[0]?.lifts[0]?.exported_as).toEqual(["run"]);
    expect(report.components[0]?.lowers[0]?.satisfies).toEqual([
      expect.objectContaining({ import_module: "host", import_name: "log" }),
    ]);
  },
);

cliTest(
  "reports gated features and nested components through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-wasm-component-cli-nest-");
    const path = join(root, "nested.wasm");
    await writeFile(path, nestedComponent(1, gatedFeatureComponent()));
    const result = await cli.run({
      arguments: ["inspect-wasm-component", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = toolContract("inspect_wasm_component").outputSchema.parse(
      result.json,
    ).normalized_result;
    expect(report.components.map(({ id, parent }) => ({ id, parent }))).toEqual(
      [
        { id: 0, parent: null },
        { id: 1, parent: 0 },
      ],
    );
    expect(report.gated_features).toContain("async");
  },
);

cliTest(
  "rejects an unadmitted component version as an unsupported target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-wasm-component-cli-ver-");
    const path = join(root, "old.wasm");
    await writeFile(path, withPreamble(representativeComponent(), 0x0c, 0x01));
    const result = await cli.run({
      arguments: ["inspect-wasm-component", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: { operation: "inspect_wasm_component", path },
    });
  },
);
