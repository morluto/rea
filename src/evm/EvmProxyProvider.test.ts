import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { EvmProxyProvider } from "./EvmProxyProvider.js";
import { inspectEvmProxyInputSchema } from "../domain/evm/evmProxy.js";

const CLONE =
  "363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3";

const carrier = async (content: string) => {
  const path = join(await createTestTempDirectory("rea-evm-proxy-"), "a.hex");
  await writeFile(path, content);
  return path;
};

const inspect = async (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  const provider = new EvmProxyProvider();
  try {
    return await provider.inspect(
      inspectEvmProxyInputSchema.parse(input),
      signal === undefined ? undefined : { signal },
    );
  } finally {
    await provider.close();
  }
};

describe("inspect_evm_proxy", () => {
  it("keeps carrier and decoded identities distinct", async () => {
    const path = await carrier(`0x${CLONE}\n`);
    const result = await inspect({ path, encoding: "hex" });
    expect(result.ok && result.value).toMatchObject({
      artifact: { path, bytes: CLONE.length + 3, encoding: "hex" },
      bytecode: { bytes: 45 },
      pattern: {
        kind: "erc1167",
        implementation: `0x${"be".repeat(20)}`,
      },
    });
  });

  it("returns typed resource and cancellation failures", async () => {
    const path = await carrier(CLONE);
    const limited = await inspect({
      path,
      encoding: "hex",
      max_file_bytes: 89,
    });
    expect(!limited.ok && limited.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    const cancelled = new AbortController();
    cancelled.abort();
    const aborted = await inspect({ path, encoding: "hex" }, cancelled.signal);
    expect(!aborted.ok && aborted.error).toMatchObject({
      _tag: "AnalysisCancelledError",
    });
  });

  it("reports malformed hex as a malformed target", async () => {
    const path = await carrier("0x363");
    const result = await inspect({ path, encoding: "hex" });
    expect(!result.ok && result.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
    });
  });

  it("follows a related account and names the one that fails", async () => {
    const path = await carrier(CLONE);
    const snapshot = (account: string) => ({
      chain_id: 1,
      block: 1,
      account,
      slots: {},
    });
    const target = `0x${"be".repeat(20)}`;
    const request = (relatedPath: string) => ({
      path,
      encoding: "hex",
      snapshot: snapshot(`0x${"11".repeat(20)}`),
      related: [
        { path: relatedPath, encoding: "hex", snapshot: snapshot(target) },
      ],
    });
    const followed = await inspect(request(await carrier("0x00")));
    expect(followed.ok && followed.value).toMatchObject({
      related: [{ reached: true }],
      chain: [{ to: target, status: "supplied" }],
    });
    const broken = await carrier("0x0");
    const failed = await inspect(request(broken));
    expect(!failed.ok && failed.error).toMatchObject({
      _tag: "AnalysisTargetFailureError",
      path: broken,
    });
  });
});
