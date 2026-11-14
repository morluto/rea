import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { readBinaryNinjaConfiguration } from "./BinaryNinjaConfiguration.js";
import { BinaryNinjaProvider } from "./BinaryNinjaProvider.js";
import { ProviderInspectionScope } from "../application/ProviderInspectionScope.js";
import {
  createBinaryNinjaTarget,
  RecordingBinaryNinjaMcp,
} from "../../tests/fixtures/binaryNinjaMcp.js";

const resourceScope = {
  run: <T>(operation: () => Promise<T>) => operation(),
  retain: () => {
    throw new Error("Unexpected retained configuration descriptor");
  },
};

const registration = async (value: unknown) => {
  const root = await createTestTempDirectory("rea-binary-ninja-config-");
  const path = join(root, "binary-ninja-mcp.json");
  await writeFile(path, JSON.stringify(value));
  return path;
};

const provider = (path?: string) => {
  const config = parseConfig(
    path === undefined ? {} : { REA_BINARY_NINJA_MCP_CONFIG: path },
  );
  if (!config.ok) throw config.error;
  return new BinaryNinjaProvider(config.value);
};

const pe = (managed: boolean): BinaryTarget => ({
  path: "/tmp/app.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed,
});

describe("Binary Ninja registration", () => {
  it("accepts the GUI server URL with an optional header, alone or in a client envelope", async () => {
    const direct = await readBinaryNinjaConfiguration(
      await registration({ url: "http://127.0.0.1:24642/mcp" }),
      { resourceScope },
    );
    expect(direct.ok && direct.value).toMatchObject({
      timeoutMs: 300_000,
      headers: {},
    });
    const envelope = await readBinaryNinjaConfiguration(
      await registration({
        mcpServers: {
          "binaryninja-gui": {
            url: "http://[::1]:24642/mcp",
            headers: { Authorization: "Bearer t" },
          },
        },
      }),
      { resourceScope },
    );
    expect(envelope.ok).toBe(true);
  });

  it("rejects non-loopback hosts, URL credentials, queries and ambiguous envelopes", async () => {
    for (const value of [
      { url: "http://192.168.1.2:24642/mcp" },
      { url: "http://localhost:24642/mcp" },
      { url: "http://user:pass@127.0.0.1:24642/mcp" },
      { url: "http://127.0.0.1:24642/mcp?token=x" },
      { url: "http://127.0.0.1:24642/mcp", command: "binaryninja_mcp" },
      {
        mcpServers: {
          a: { url: "http://127.0.0.1:1/mcp" },
          b: { url: "http://127.0.0.1:2/mcp" },
        },
      },
    ])
      expect(
        (
          await readBinaryNinjaConfiguration(await registration(value), {
            resourceScope,
          })
        ).ok,
      ).toBe(false);
  });
});

it("reports malformed headers as unavailable and observes a repaired registration", async () => {
  const path = await registration({
    url: "http://127.0.0.1:24642/mcp",
    headers: { Authorization: "Bearer private-token\ninvalid" },
  });
  const candidate = provider(path);
  const availability = await candidate.inspectAvailability();
  expect(availability).toMatchObject({
    status: "unavailable",
    code: "open_options_invalid",
    remediation: expect.stringContaining("REA_BINARY_NINJA_MCP_CONFIG"),
  });
  expect(JSON.stringify(availability)).not.toContain("private-token");
  expect(await candidate.resolveAnalysisProfile(pe(false))).toMatchObject({
    ok: false,
    error: { _tag: "ConfigurationError" },
  });
  await writeFile(
    path,
    JSON.stringify({
      url: "http://127.0.0.1:24642/mcp",
      headers: { Authorization: " Bearer repaired " },
    }),
  );
  expect((await candidate.inspectAvailability()).status).toBe("available");
});

describe("Binary Ninja provider", () => {
  it("preserves the reason when profile resolution is already cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("profile cancelled by caller");
    controller.abort(reason);
    const result = await provider().resolveAnalysisProfile(pe(false), {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", cause: reason },
    });
  });
  it("observes repaired registrations on a later inspection", async () => {
    const path = await registration({ url: "http://example.com/mcp" });
    const candidate = provider(path);
    expect((await candidate.inspectAvailability()).status).toBe("unavailable");
    await writeFile(
      path,
      JSON.stringify({ url: "http://127.0.0.1:24642/mcp" }),
    );
    expect((await candidate.inspectAvailability()).status).toBe("available");
  });

  it("binds inspected credentials to the selected target/profile and refreshes the next scope", async () => {
    const { target, bytes } = await createBinaryNinjaTarget();
    const path = await registration({
      url: "http://127.0.0.1:24642/mcp",
      headers: { Authorization: "Bearer initial" },
    });
    const config = parseConfig({ REA_BINARY_NINJA_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    const credentials: string[] = [];
    const candidate = new BinaryNinjaProvider(config.value, (registration) => {
      credentials.push(registration.headers.authorization!);
      return new RecordingBinaryNinjaMcp(target, bytes);
    });
    const scope = new ProviderInspectionScope();
    await candidate.inspectAvailability({ scope });
    await writeFile(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:24642/mcp",
        headers: { Authorization: "Bearer rotated" },
      }),
    );
    const selected = await candidate.resolveAnalysisProfile(target, { scope });
    if (
      !selected.ok ||
      selected.value.profile === null ||
      selected.value.createClient === undefined
    )
      throw new Error("Expected bound profile");
    const client = selected.value.createClient(target, selected.value.profile);
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    await client.close();
    expect(credentials).toEqual(["Bearer initial"]);
    const mismatch = selected.value.createClient(
      { ...target, sha256: "f".repeat(64) },
      selected.value.profile,
    );
    expect((await mismatch.execute("health", {})).ok).toBe(false);
    expect(credentials).toHaveLength(1);
    expect(
      (
        await candidate
          .createClient(target, selected.value.profile)
          .execute("health", {})
      ).ok,
    ).toBe(false);
    scope.close();
    const next = await candidate.resolveAnalysisProfile(target, {
      scope: new ProviderInspectionScope(),
    });
    if (
      !next.ok ||
      next.value.profile === null ||
      next.value.createClient === undefined
    )
      throw new Error("Expected next bound profile");
    const nextClient = next.value.createClient(target, next.value.profile);
    expect(credentials).toEqual(["Bearer initial", "Bearer rotated"]);
    expect(next.value.profile.digest).toBe(selected.value.profile.digest);
    await nextClient.close();
  });
  it("is not configured without a registration, so auto selection stays unambiguous", async () => {
    expect(await provider().inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
  });

  it("reports an invalid registration as invalid open options", async () => {
    const path = await registration({ url: "http://example.com/mcp" });
    expect(await provider(path).inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "open_options_invalid",
    });
  });

  it("admits PE, ELF and thin Mach-O executables only", async () => {
    const candidate = provider(
      await registration({ url: "http://127.0.0.1:24642/mcp" }),
    );
    expect(candidate.inspectTargetSupport(pe(false)).status).toBe("supported");
    expect(candidate.inspectTargetSupport(pe(true))).toMatchObject({
      code: "managed_target_unsupported",
    });
    expect(
      candidate.inspectTargetSupport({
        path: "/tmp/fw.bin",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "raw-binary",
        architecture: "arm",
        availableArchitectures: ["arm"],
        entryPoint: "0x0",
        entryPointSource: "0x0",
      }),
    ).toMatchObject({ code: "target_format_unsupported" });
    expect(
      candidate.inspectTargetSupport({
        path: "/tmp/db.bndb",
        sha256: "a".repeat(64),
        kind: "database",
        format: "analysis-database",
      }),
    ).toMatchObject({ code: "target_kind_unsupported" });
  });

  it("commits registration settings without credential-derived values", async () => {
    const first = await provider(
      await registration({
        url: "http://127.0.0.1:24642/mcp",
        headers: { Authorization: "Bearer one" },
      }),
    ).resolveAnalysisProfile(pe(false));
    const second = await provider(
      await registration({
        url: "http://127.0.0.1:24642/mcp",
        headers: { Authorization: "Bearer two" },
      }),
    ).resolveAnalysisProfile(pe(false));
    if (!first.ok || !second.ok) throw new Error("expected profiles");
    expect(first.value.profile?.digest).toBe(second.value.profile?.digest);
    expect(JSON.stringify(first.value.profile)).not.toContain("one");
  });
});

const regexFixture = async (deadlineMs = 5000) => {
  const { target, bytes } = await createBinaryNinjaTarget();
  const path = await registration({ url: "http://127.0.0.1:24642/mcp" });
  const config = parseConfig({
    REA_BINARY_NINJA_MCP_CONFIG: path,
    REA_REGEX_MATCHING_DEADLINE_MS: String(deadlineMs),
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: "64",
  });
  if (!config.ok) throw config.error;
  const producer = new RecordingBinaryNinjaMcp(target, bytes);
  const candidate = new BinaryNinjaProvider(config.value, () => producer);
  const selected = await candidate.resolveAnalysisProfile(target);
  if (
    !selected.ok ||
    selected.value.profile === null ||
    selected.value.createClient === undefined
  )
    throw new Error("Expected bound profile");
  return {
    producer,
    client: selected.value.createClient(target, selected.value.profile),
    profile: selected.value.profile,
  };
};

describe.each(["search_procedures", "search_strings"] as const)(
  "Binary Ninja %s regex matching",
  (operation) => {
    it("preserves Unicode matching, case sensitivity, and literal mode", async () => {
      const { client, producer } = await regexFixture();
      const text = "Ångström [x]";
      producer.functions = producer.functions.map((fn) => ({
        ...fn,
        name: text,
      }));
      producer.strings = [
        { address: "0x402000", type: "Utf8String", bytes: Buffer.from(text) },
      ];
      try {
        const insensitive = await client.execute(operation, {
          mode: "regex",
          pattern: "^ångström",
        });
        expect(insensitive).toMatchObject({
          ok: true,
          value: {
            result: expect.arrayContaining([
              expect.objectContaining({ value: text }),
            ]),
          },
        });
        const sensitive = await client.execute(operation, {
          mode: "regex",
          pattern: "^ångström",
          case_sensitive: true,
        });
        expect(sensitive).toMatchObject({ ok: true, value: { result: [] } });
        const literal = await client.execute(operation, { pattern: "[x]" });
        expect(literal.ok && literal.value.result).toEqual(
          insensitive.ok && insensitive.value.result,
        );
        expect(
          await client.execute(operation, { mode: "regex", pattern: "[" }),
        ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    });

    it.each(["deadline", "cancellation"] as const)(
      "stops pathological matching on %s and keeps the session usable",
      async (stop) => {
        const { client, producer } = await regexFixture(
          stop === "deadline" ? 150 : 5000,
        );
        const text = "a".repeat(64) + "!";
        producer.functions = producer.functions.map((fn) => ({
          ...fn,
          name: text,
        }));
        producer.strings = [
          {
            address: "0x402000",
            type: "AsciiString",
            bytes: Buffer.from(text),
          },
        ];
        const controller = new AbortController();
        const timer =
          stop === "cancellation"
            ? setTimeout(() => controller.abort(), 150)
            : undefined;
        try {
          const result = await client.execute(
            operation,
            { mode: "regex", pattern: "^(a+)+$" },
            { signal: controller.signal },
          );
          expect(result).toMatchObject({
            ok: false,
            error: {
              _tag:
                stop === "deadline"
                  ? "AnalysisResourceConstraintError"
                  : "AnalysisCancelledError",
            },
          });
          if (!result.ok && stop === "deadline")
            expect(result).toMatchObject({
              error: {
                reportedLimits: {
                  matching_deadline_ms: 150,
                  matching_deadline_source: "setting",
                },
              },
            });
          const recovered = await client.execute(operation, { pattern: "!" });
          expect(recovered.ok && recovered.value.result).toEqual(
            expect.arrayContaining([expect.objectContaining({ value: text })]),
          );
        } finally {
          clearTimeout(timer);
          expect((await client.close()).ok).toBe(true);
          expect(producer.closes).toBe(1);
        }
      },
    );
  },
);

it("keeps the bound analysis profile on partial Evidence after a failed read", async () => {
  const { client, producer, profile } = await regexFixture();
  producer.beforeCall = (name) => {
    if (name === "bn_function_list")
      producer.rawBytes = Buffer.from(producer.rawBytes).fill(0, 0, 4);
  };
  try {
    const result = await client.execute("list_procedures", {});
    expect(result).toMatchObject({
      ok: false,
      error: {
        partialObservation: {
          analysis_profile: profile,
          normalized_result: { status: "partial" },
        },
      },
    });
  } finally {
    expect((await client.close()).ok).toBe(true);
  }
});
