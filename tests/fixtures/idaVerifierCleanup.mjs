import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerHooks } from "node:module";

import { idaCleanupState } from "./idaVerifierCleanupMock.mjs";

const mockUrl = new URL("./idaVerifierCleanupMock.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ? new URL(context.parentURL).pathname : "";
    if (!parent.endsWith("/scripts/verify-real-ida.mjs"))
      return next(specifier, context);
    if (
      specifier === "node:child_process" ||
      specifier === "node:util" ||
      specifier === "@modelcontextprotocol/client" ||
      specifier === "@modelcontextprotocol/client/stdio" ||
      specifier.endsWith("/ida-feature-trace.mjs") ||
      specifier.endsWith("/mcp-verifier-results.mjs") ||
      specifier.endsWith("/verifier-file-resources.mjs") ||
      specifier.includes("/dist/")
    )
      return { shortCircuit: true, url: mockUrl };
    return next(specifier, context);
  },
});

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), "rea-inert-ida-finalizer-"),
);
const target = path.join(workspace, "not-executed.bin");
const reportPath = path.join(workspace, "report.json");
await fs.writeFile(target, "inert verifier input");
idaCleanupState.target = target;
idaCleanupState.report = reportPath;
process.env.REA_IDA_MCP_CONFIG = "/inert/config";
const write = console.log.bind(console);
try {
  for (const failClose of [false, true]) {
    idaCleanupState.failClose = failClose;
    idaCleanupState.events = [];
    process.exitCode = 0;
    const captured = [];
    console.log = (value) => {
      captured.push(value);
    };
    if (failClose)
      await import("../../scripts/verify-real-ida.mjs?attempt=fail");
    else await import("../../scripts/verify-real-ida.mjs?attempt=pass");
    console.log = write;
    const output = JSON.parse(captured[0]);
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(output.passed, false);
    assert.equal(process.exitCode, 1);
    assert.equal(idaCleanupState.events.includes("client.close"), true);
    assert.equal(idaCleanupState.events.includes("transport.close"), true);
    if (failClose)
      assert.deepEqual(report.failure.causes, [
        idaCleanupState.primary.message,
        idaCleanupState.cleanup.message,
      ]);
    else assert.equal(report.failure.message, idaCleanupState.primary.message);
    write(
      JSON.stringify({
        failClose,
        events: idaCleanupState.events,
        reportedPassed: output.passed,
        failureMessage: report.failure.message,
      }),
    );
  }
  process.exitCode = 0;
} finally {
  console.log = write;
  await fs.rm(workspace, { recursive: true, force: true });
}
