import { access, readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { binaryNinjaFixture } from "./BinaryNinja.fixture.js";
import { BinaryNinjaMcp, records } from "./BinaryNinjaMcp.js";
import { BinaryNinjaProvider } from "./BinaryNinjaProvider.js";
import { parseConfig } from "../config.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import type { AnalysisClient } from "../application/AnalysisProvider.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const setup = async (options?: Parameters<typeof binaryNinjaFixture>[0]) => {
  const fixture = await binaryNinjaFixture(options);
  cleanup.push(fixture.close);
  return fixture;
};
const session = async (
  fixture: Awaited<ReturnType<typeof binaryNinjaFixture>>,
): Promise<AnalysisClient> => {
  const client = fixture.provider.createClient(
    fixture.target,
    await fixture.resolve(),
  );
  cleanup.push(() => client.close().catch(() => undefined));
  return client;
};

it("does not connect or open a file during target-free discovery", async () => {
  const fixture = await setup();
  expect(fixture.provider.identity().id).toBe("binary-ninja");
  expect(fixture.provider.inspectAvailability()).toMatchObject({
    status: "available",
    diagnostics: { connection_verified: false },
  });
  expect(fixture.calls).toEqual([]);
  const profile = await fixture.resolve();
  expect(profile.provider.version).toBe("5.3-test");
  expect(fixture.calls).toEqual([]);
  expect(JSON.stringify(profile)).not.toContain("test-auth-token");
});

it("imports a verified private copy, drains all pages and preserves 64-bit addresses", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  const original = await readFile(fixture.target.path);
  const result = await client.execute("list_procedures", {});
  expect(result).toMatchObject({
    ok: true,
    value: {
      result: [
        { address: "0x401000", value: "main" },
        { address: "0xfffffffffffffff0", value: "helper" },
      ],
      provider: { id: "binary-ninja" },
    },
  });
  expect(fixture.snapshots[0]).not.toBe(fixture.target.path);
  expect(
    fixture.calls
      .filter(({ name }) => name === "bn_function_list")
      .map(({ input }) => input.offset),
  ).toEqual([0, 1]);
  await client.close();
  expect(
    fixture.calls
      .filter(({ name }) => name === "bn_open_item_close")
      .map(({ input }) => input.openItem),
  ).toEqual(["owned-item"]);
  expect(fixture.calls.some(({ name }) => name.includes("save"))).toBe(false);
  expect(await readFile(fixture.target.path)).toEqual(original);
  const snapshot = fixture.snapshots[0];
  if (snapshot === undefined) throw new Error("No snapshot");
  await expect(access(snapshot)).rejects.toThrow();
  await client.close();
});

it("supports pseudocode, assembly, byte completeness and composed dossiers", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  expect(
    await client.execute("procedure_pseudo_code", { procedure: "main" }),
  ).toMatchObject({
    ok: true,
    value: { result: "int main() { return 0; }" },
  });
  expect(
    await client.execute("read_bytes", { address: "0x401000", length: 4 }),
  ).toMatchObject({
    ok: true,
    value: {
      result: { returned_bytes: 2, complete: false, bytes_hex: "31c0" },
    },
  });
  const result = await client.execute("analyze_function", {
    procedure: "main",
  });
  if (!result.ok) throw result.error;
  const dossier = functionDossierSchema.parse(result.value.result);
  expect(dossier.procedure.body.available).toBe(false);
  expect(dossier.callees[0]?.address).toBe("0xfffffffffffffff0");
  expect(dossier.assembly).toEqual(["0x401000  xor eax, eax", "0x401002  ret"]);
  expect(dossier.limitations.join(" ")).toContain("unobserved");
});

it("applies complete regex/literal searches with REA case semantics", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  expect(
    await client.execute("search_strings", { pattern: "WORLD" }),
  ).toMatchObject({
    ok: true,
    value: { result: [{ address: "0x402000", value: "Hello World" }] },
  });
  expect(
    await client.execute("search_procedures", {
      pattern: "^HELP",
      mode: "regex",
    }),
  ).toMatchObject({
    ok: true,
    value: { result: [{ address: "0xfffffffffffffff0", value: "helper" }] },
  });
  expect(
    await client.execute("search_strings", {
      pattern: "WORLD",
      case_sensitive: true,
    }),
  ).toMatchObject({ ok: true, value: { result: [] } });
  expect(
    await client.execute("search_strings", { pattern: "[", mode: "regex" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("rejects unsupported operations and cancelled callers before starting Binary Ninja", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  expect(
    await client.execute("set_comment", {
      address: "0x401000",
      comment: "test",
    }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(
    await client.execute(
      "list_procedures",
      {},
      { signal: AbortSignal.abort() },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  expect(fixture.calls).toEqual([]);
});

it("rejects a target that changes between selection and import", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  await writeFile(fixture.target.path, "changed");
  expect(await client.execute("health", {})).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  expect(fixture.calls.some(({ name }) => name === "bn_file_open")).toBe(false);
  expect(await client.execute("health", {})).toMatchObject({ ok: false });
});

it("cleans up its imported item after startup failure and never starts a second import", async () => {
  const fixture = await setup({ failActivation: true });
  const client = await session(fixture);
  expect(await client.execute("health", {})).toMatchObject({ ok: false });
  expect(
    fixture.calls.filter(({ name }) => name === "bn_open_item_close"),
  ).toHaveLength(1);
  expect(await client.execute("health", {})).toMatchObject({ ok: false });
  expect(fixture.snapshots).toHaveLength(1);
});

it("reports cleanup failure and retains the target copy while ownership is uncertain", async () => {
  const fixture = await setup({ failClose: true });
  const client = await session(fixture);
  expect(await client.execute("health", {})).toMatchObject({ ok: true });
  expect(await client.closeWithOutcome?.()).toMatchObject({
    ok: false,
    error: { _tag: "ProviderAdapterError" },
  });
  const snapshot = fixture.snapshots[0];
  if (snapshot === undefined) throw new Error("No snapshot");
  await expect(access(snapshot)).resolves.toBeUndefined();
});

it("fails on non-progressing pagination instead of silently returning a partial inventory", async () => {
  const fixture = await setup({ brokenPagination: true });
  const client = await session(fixture);
  expect(await client.execute("list_procedures", {})).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("reports missing server tools, preserves remote errors and redacts bearer tokens", async () => {
  const fixture = await setup({ missingTool: "bn_function_pseudo_c" });
  const client = await session(fixture);
  expect(
    await client.execute("procedure_pseudo_code", { procedure: "main" }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  const failed = await setup({
    tokenError: "request failed using test-auth-token",
  });
  const failedClient = await session(failed);
  const result = await failedClient.execute("procedure_pseudo_code", {
    procedure: "main",
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      diagnostics: { reason: "remote_tool_error" },
    },
  });
  expect(JSON.stringify(result)).not.toContain("test-auth-token");
  expect(JSON.stringify(result)).toContain("[redacted]");
});

it("rejects a plugin without built-in lifecycle tools", async () => {
  const fixture = await setup({ missingTool: "bn_binary_view_set_active" });
  expect(
    await fixture.provider.resolveAnalysisProfile(fixture.target),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
});

it("rejects arbitrary document routing and reports missing function names", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  expect(
    await client.execute("list_procedures", { document: "unrelated.elf" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(
    await client.execute("procedure_address", { procedure: "missing" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(
    await client.execute("procedure_address", {
      procedure: "0xFFFFFFFFFFFFFFF0",
    }),
  ).toMatchObject({ ok: true, value: { result: "0xfffffffffffffff0" } });
});

it("marks unconfigured providers unavailable and rejects unimplemented loader profiles", async () => {
  const parsed = parseConfig({});
  if (!parsed.ok) throw parsed.error;
  expect(
    new BinaryNinjaProvider(parsed.value).inspectAvailability(),
  ).toMatchObject({ status: "unavailable", code: "not_configured" });
  const fixture = await setup();
  expect(
    fixture.provider.inspectTargetSupport({
      ...fixture.target,
      kind: "executable",
      format: "dos-com",
      architecture: "x86",
      availableArchitectures: ["x86"],
    }),
  ).toMatchObject({
    status: "unsupported",
    code: "target_format_unsupported",
  });
});

it("parses table and object rows but refuses unknown result formats", () => {
  expect(
    records(
      { columns: ["address", "name"], rows: [["0x1", "main"]] },
      "functions",
    ),
  ).toEqual([{ address: "0x1", name: "main" }]);
  expect(() =>
    records({ columns: ["name"], rows: [["a", "b"]] }, "functions"),
  ).toThrow("width");
  expect(() => records("not a JSON inventory", "functions")).toThrow();
});

it("uses the SDK's text JSON fallback when structured content is unavailable", async () => {
  const fixture = await setup({ textOnly: true });
  const config = fixture.config.binaryNinjaMcp;
  if (config === undefined) throw new Error("Missing fixture config");
  const mcp = new BinaryNinjaMcp(config, fixture.factory);
  cleanup.push(() => mcp.close());
  await mcp.connect();
  expect(mcp.inventory().functions).toBe("bn_function_list");
  expect(await mcp.list("functions")).toHaveLength(2);
});

it("reports cancellation during a live MCP request and can execute a later query", async () => {
  const controller = new AbortController();
  const fixture = await setup({ beforePseudocode: () => controller.abort() });
  const client = await session(fixture);
  expect(
    await client.execute(
      "procedure_pseudo_code",
      { procedure: "main" },
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  expect(await client.execute("list_strings", {})).toMatchObject({ ok: true });
});

it("requires completed analysis and does not misreport a false closure response", async () => {
  const incomplete = await setup({ analysisComplete: false });
  const client = await session(incomplete);
  expect(await client.execute("health", {})).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  expect(
    incomplete.calls.filter(({ name }) => name === "bn_open_item_close"),
  ).toHaveLength(1);
  const refused = await setup({ closeRefused: true });
  const refusedClient = await session(refused);
  expect(await refusedClient.execute("health", {})).toMatchObject({ ok: true });
  expect(await refusedClient.closeWithOutcome?.()).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it("requires explicit memory addresses and validates them as caller input", async () => {
  const fixture = await setup();
  const client = await session(fixture);
  expect(
    await client.execute("read_bytes", { address: "invalid", length: 4 }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(await client.execute("address_name", {})).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(
    await client.execute("address_name", { address: "0x401000" }),
  ).toMatchObject({ ok: true, value: { result: "main" } });
});
