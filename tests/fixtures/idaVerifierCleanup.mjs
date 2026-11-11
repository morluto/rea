import vm from "node:vm";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as util from "node:util";
import assert from "node:assert/strict";
const filename = new URL("../../scripts/verify-real-ida.mjs", import.meta.url);
const source = await fs.readFile(filename, "utf8");
const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), "rea-inert-ida-finalizer-"),
);
const target = path.join(workspace, "not-executed.bin");
await fs.writeFile(target, "inert verifier input");
try {
  for (const failClose of [false, true]) {
    const primary = new Error("inert analyze failure"),
      cleanup = new Error("inert close_binary failure");
    const events = [],
      outputs = [];
    let report;
    const processView = {
      ...process,
      env: { ...process.env, REA_IDA_MCP_CONFIG: "/inert/config" },
      exitCode: 0,
    };
    const dossier = {
      pseudocode: "int main(){}",
      assembly: ["ret"],
      procedure: { body: { available: false } },
    };
    const evidence = {
      provider: { id: "ida", version: "1" },
      analysis_profile: {
        parameters: { cache_policy: "live", engine_version: null },
      },
      limitations: ["inert"],
      locations: [{ kind: "artifact-path" }],
      operation: "analyze_function",
      relationship_coverage: { status: "unknown" },
      normalized_result: dossier,
    };
    const config = { mode: "attached", protocol: "native", timeoutMs: 100 };
    const execFile = () => {
      throw new Error("Spawning forbidden");
    };
    execFile[util.promisify.custom] = async () => ({
      stdout: JSON.stringify(evidence),
    });
    class Client {
      async connect() {
        events.push("connect");
      }
      async callTool({ name }) {
        events.push(name);
        if (name === "analyze_function") throw primary;
        if (name === "close_binary" && failClose) throw cleanup;
        return { structuredContent: {} };
      }
      async close() {
        events.push("client.close");
      }
    }
    class Transport {
      async close() {
        events.push("transport.close");
      }
    }
    let context;
    const build = async (values) => {
      const m = new vm.SyntheticModule(
        Object.keys(values),
        function () {
          for (const [k, v] of Object.entries(values)) this.setExport(k, v);
        },
        { context },
      );
      await m.link(() => {});
      await m.evaluate();
      return m;
    };
    const exportsFor = async (specifier) => {
      if (specifier === "node:child_process") return { execFile };
      if (specifier === "node:fs/promises")
        return {
          ...fs,
          writeFile: async (_path, text) => {
            report = JSON.parse(text);
          },
        };
      if (specifier === "node:util")
        return {
          ...util,
          parseArgs: () => ({
            values: {
              target,
              report: "/inert/report",
              procedure: "main",
              "second-procedure": "helper",
              "second-marker": "marker",
            },
          }),
        };
      if (specifier.startsWith("node:")) return import(specifier);
      if (specifier === "@modelcontextprotocol/client") return { Client };
      if (specifier === "@modelcontextprotocol/client/stdio")
        return { StdioClientTransport: Transport };
      if (specifier.endsWith("/ida-feature-trace.mjs"))
        return { assertFeatureTrace() {}, findMappedNonFunction() {} };
      if (specifier.endsWith("/mcp-verifier-results.mjs"))
        return { requireMcpToolError() {} };
      if (specifier.endsWith("/verifier-cleanup.mjs"))
        return import(new URL(specifier, filename));
      if (specifier.endsWith("/verifier-file-resources.mjs"))
        return { withVerifierResourceOwner: (operation) => operation({}) };
      if (specifier.endsWith("/toolContracts.js"))
        return { toolContract: () => ({ outputSchema: { parse: (v) => v } }) };
      if (specifier.endsWith("/evidence.js"))
        return { evidenceSchema: { parse: (v) => v } };
      if (specifier.endsWith("/functionDossier.js"))
        return { functionDossierSchema: { parse: (v) => v } };
      if (specifier.endsWith("/IdaConfiguration.js"))
        return {
          readIdaConfiguration: async () => ({ ok: true, value: config }),
          idaCompatibilityProfile: () => ({ protocol: "native" }),
        };
      if (specifier.endsWith("/IdaMcpConnection.js"))
        return {
          createIdaMcpConnection() {
            throw new Error("upstream never reached");
          },
        };
      if (specifier.endsWith("/IdaProtocolValues.js"))
        return { idaAddressSchema: { parse: (v) => v } };
      throw new Error("Unexpected import " + specifier);
    };
    context = vm.createContext({
      process: processView,
      console: { log: (value) => outputs.push(JSON.parse(value)) },
      URL,
      Buffer,
      Error,
      AggregateError,
    });
    const m = new vm.SourceTextModule(source, {
      context,
      identifier: filename.href,
      initializeImportMeta(meta) {
        meta.url = filename.href;
      },
      importModuleDynamically: async (specifier) =>
        build(await exportsFor(specifier)),
    });
    await m.link(async (specifier) => build(await exportsFor(specifier)));
    await m.evaluate();
    const output = outputs[0];
    assert.equal(output.passed, false);
    assert.equal(processView.exitCode, 1);
    assert.equal(events.includes("client.close"), true);
    assert.equal(events.includes("transport.close"), true);
    if (failClose)
      assert.deepEqual(report.failure.causes, [
        primary.message,
        cleanup.message,
      ]);
    else assert.equal(report.failure.message, primary.message);
    console.log(
      JSON.stringify({
        failClose,
        events,
        reportedPassed: output.passed,
        failureMessage: report.failure.message,
      }),
    );
  }
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
