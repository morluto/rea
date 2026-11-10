import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it("loads the Frida verifier help without starting instrumentation", async () => {
  const result = await execute(process.execPath, [
    "scripts/verify-frida.mjs",
    "--help",
  ]);
  expect(result.stdout).toContain(
    "Without flags, verifies a local Node.js process",
  );
});

it("requires marker identity to match the selected target", async () => {
  const root = await createTestTempDirectory("rea-frida-verifier-");
  const preload = join(root, "provider.mjs");
  await writeFile(
    preload,
    `
import { registerHooks } from 'node:module';
const service = \`
export class FridaInstrumentationService {
  async listProcesses() { return { ok: true, value: { processes: [{ pid: 41, name: 'selected' }] } }; }
  async instrument() {
    const pid = process.env.REA_PROBE_KIND === 'missing' ? undefined : process.env.REA_PROBE_KIND === 'correct' ? 41 : 42;
    return { ok: true, value: { cleanupError: null, evidence: { normalized_result: { pid, messages: [{ type: 'send', payload: { rea_frida_verification: 'ok', pid } }] } } } };
  }
}\`;
const manager = \`export class FridaInstrumentationManager { async closeAll() {} }\`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/scripts/verify-frida.mjs')) {
    if (specifier.endsWith('/FridaInstrumentationService.js')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(service) };
    if (specifier.endsWith('/FridaInstrumentationManager.js')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(manager) };
  }
  return next(specifier, context);
}});
`,
  );
  const invoke = (kind: string, remote: boolean) =>
    execute(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/verify-frida.mjs",
        ...(remote ? ["--address", "127.0.0.1:27042", "--pid", "41"] : []),
      ],
      { env: { ...process.env, REA_PROBE_KIND: kind }, timeout: 10_000 },
    );
  for (const [kind, remote, message] of [
    ["missing", false, "Frida returned no valid target PID"],
    ["wrong", true, "Frida observed a different target PID"],
  ] as const) {
    await expect(invoke(kind, remote)).rejects.toMatchObject({
      stderr: expect.stringContaining(message),
    });
  }
  const result = await invoke("correct", true);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    target_pid: 41,
    script_message_observed: true,
  });
});
