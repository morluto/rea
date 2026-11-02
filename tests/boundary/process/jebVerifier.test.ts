import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it("reports a decompile marker only when a nonempty requested marker was observed", async () => {
  const root = await createTestTempDirectory("rea-jeb-verifier-");
  const preload = join(root, "provider.mjs");
  await writeFile(
    preload,
    `
import { registerHooks } from 'node:module';
const service = \`
export class JebAnalysisService {
  async execute(name) {
    if (name === 'inspect_jeb_client') return { ok: true, value: { normalized_result: { engine: { version: 'fixture', gui_client: false, endpoint: 'fixture' } } } };
    if (name === 'open_jeb_project') return { ok: false, error: { message: 'not available' } };
    if (name === 'list_jeb_units') return { ok: true, value: { normalized_result: { units: [{}] } } };
    if (name === 'decompile_jeb_item') return { ok: true, value: { normalized_result: { text: process.env.REA_JEB_PROBE_TEXT ?? '' } } };
    throw new Error('unexpected operation');
  }
}\`;
const provider = \`export const createJebAnalysisProvider = () => ({ close: async () => {} });\`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/scripts/verify-jeb.mjs')) {
    if (specifier.endsWith('/JebAnalysisService.js')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(service) };
    if (specifier.endsWith('/composition/jeb.js')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(provider) };
  }
  return next(specifier, context);
}});
`,
  );
  const invoke = (text: string, marker?: string) =>
    execute(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/verify-jeb.mjs",
        "--item-address",
        "Lx;->x()V",
        ...(marker === undefined ? [] : ["--marker", marker]),
      ],
      { env: { ...process.env, REA_JEB_PROBE_TEXT: text }, timeout: 10_000 },
    );
  await expect(invoke("", undefined)).rejects.toMatchObject({
    stderr: expect.stringContaining("Decompiled pseudo-code was empty"),
  });
  await expect(invoke("void x() {}", "missing")).rejects.toMatchObject({
    stderr: expect.stringContaining("did not contain the fixture marker"),
  });
  await expect(invoke("void x() {}", "")).rejects.toMatchObject({
    stderr: expect.stringContaining("--marker must not be empty"),
  });
  expect(
    JSON.parse((await invoke("void x() {}", undefined)).stdout),
  ).toMatchObject({ ok: true, decompiled_marker_observed: false });
  expect(JSON.parse((await invoke("void x() {}", "x()")).stdout)).toMatchObject(
    { ok: true, decompiled_marker_observed: true },
  );
});
