import { readFile, readdir, rm } from "node:fs/promises";
import { sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async (
  mode: "attached" | "headless" = "attached",
  timeoutMs = 1000,
) => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target, mode);
  const client = new IdaSessionClient(
    {
      command: "fixture",
      args: [],
      env: {},
      mode,
      timeoutMs,
      workspaceRoot: root,
    },
    target,
    producer,
  );
  return { root, target, producer, client };
};

describe("headless IDA producer pagination", () => {
  it("follows reported cursors for modern inventories, pseudocode, and bare-hex assembly without losing pages", async () => {
    const { producer, client } = await fixture("headless");
    producer.overrideCall = (name, args) => {
      const first = args.offset === 0;
      const cursor = first ? { next: 1 } : { done: true };
      if (name === "decompile")
        return { code: first ? "first line" : "second line", cursor };
      if (name === "disasm")
        return {
          asm: {
            name: "main",
            start_ea: "0x1000",
            lines: [
              {
                addr: first ? "1000" : "1001",
                instruction: first ? "push rbp" : "ret",
              },
            ],
          },
          cursor,
        };
      if (name === "find_regex")
        return {
          matches: [
            {
              addr: first ? "0x3000" : "0x3002",
              string: first ? "a.b" : "a+b",
            },
          ],
          cursor,
        };
      if (name === "list_funcs") {
        const page = z
          .object({ offset: z.number() })
          .parse(args.queries).offset;
        return [
          {
            data: [
              {
                addr: page === 0 ? "0x1000" : "0x2000",
                name: page === 0 ? "main" : "other",
                size: "0x20",
              },
            ],
            next_offset: page === 0 ? 1 : null,
          },
        ];
      }
      return undefined;
    };
    const inventory = await client.execute("list_procedures", {});
    expect(inventory.ok && inventory.value.result).toHaveLength(2);
    const strings = await client.execute("list_strings", {});
    expect(strings.ok && strings.value.result).toHaveLength(2);
    const result = await client.execute("analyze_function", {
      procedure: "main",
    });
    if (!result.ok) throw result.error;
    const dossier = functionDossierSchema.parse(result.value.result);
    expect(dossier.pseudocode).toBe("first line\nsecond line");
    expect(dossier.assembly).toEqual(["0x1000: push rbp", "0x1001: ret"]);
    expect(dossier).toMatchObject({
      procedure: {
        classification: null,
        body: {
          available: false,
          reason: "IDA MCP does not report complete function body ranges.",
        },
      },
      native_api: null,
      native_value_flow: null,
    });
    await client.close();
  });
});

describe("attached IDA observation semantics", () => {
  it("returns cold and pending startup calls immediately, then cancels queued work before dispatch", async () => {
    const { producer, client } = await fixture("headless");
    await expect(client.executeIfReady("list_procedures", {})).resolves.toBe(
      undefined,
    );
    expect(producer.connects).toBe(0);

    let enterOpen: (() => void) | undefined;
    let finishOpen: (() => void) | undefined;
    const openEntered = new Promise<void>((resolve) => {
      enterOpen = resolve;
    });
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    producer.beforeCall = async (name) => {
      if (name === "idb_open") {
        enterOpen?.();
        await openGate;
      }
    };
    const startup = client.execute("list_procedures", {});
    await openEntered;
    await expect(client.executeIfReady("list_strings", {})).resolves.toBe(
      undefined,
    );
    expect(
      producer.calls.filter(({ name }) => name === "idb_open"),
    ).toHaveLength(1);
    finishOpen?.();
    const started = await startup;
    if (!started.ok) throw started.error;
    const warm = await client.executeIfReady("list_procedures", {});
    if (warm === undefined) throw new Error("expected ready IDA dispatch");
    if (!warm.ok) throw warm.error;
    expect(warm.value.result).toEqual([
      expect.objectContaining({ address: "0x1000", value: "main" }),
    ]);

    let enterRead: (() => void) | undefined;
    let finishRead: (() => void) | undefined;
    const readEntered = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    producer.beforeCall = async (name) => {
      if (name === "list_funcs") {
        enterRead?.();
        await readGate;
      }
    };
    const active = client.execute("list_procedures", {});
    await readEntered;
    const controller = new AbortController();
    const queued = client.executeIfReady(
      "list_strings",
      {},
      {
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    finishRead?.();
    const activeResult = await active;
    if (!activeResult.ok) throw activeResult.error;
    expect(
      producer.calls.filter(({ name }) => name === "list_funcs"),
    ).toHaveLength(3);
    expect(producer.calls.some(({ name }) => name === "find_regex")).toBe(
      false,
    );
    await client.close();
  });

  it("accepts a normalized spelling of the bound document path", async () => {
    const { target, producer, client } = await fixture();
    const equivalent =
      process.platform === "win32"
        ? target.path.toLowerCase().replaceAll("\\", "/")
        : target.path.split(sep).join(`${sep}.${sep}`);

    const result = await client.execute("list_procedures", {
      document: equivalent,
    });

    expect(result.ok).toBe(true);
    expect(producer.calls.some(({ name }) => name === "list_functions")).toBe(
      true,
    );
    await client.close();
  });

  it("rejects an unrelated document before connecting or opening a provider", async () => {
    const { producer, client } = await fixture();
    const result = await client.execute("list_procedures", {
      document: "/unrelated/input",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisInputError");
      expect(result.error.message).toContain("list_procedures");
    }
    expect(producer.connects).toBe(0);
    expect(producer.calls).toEqual([]);
    await client.close();
  });
  it("preserves hexadecimal-looking function names as names unless the caller uses an explicit 0x address", async () => {
    const { producer, client } = await fixture();
    producer.overrideCall = (name, args) =>
      name === "get_function_by_name" && args.name === "f"
        ? { address: "0x1000", name: "f", size: "0x20" }
        : undefined;
    const found = await client.execute("procedure_address", { procedure: "f" });
    expect(found.ok && found.value.result).toBe("0x1000");
    expect(
      producer.calls.some(({ name }) => name === "get_function_by_address"),
    ).toBe(false);
    await client.close();
  });
  it("preserves omitted optional arguments and rejects explicit null before connecting", async () => {
    const { producer, client } = await fixture();
    for (const [operation, parameters] of [
      ["list_procedures", { document: null }],
      ["list_strings", { address: null }],
      ["procedure_pseudo_code", { procedure: null }],
    ] as const) {
      const result = await client.execute(operation, parameters);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          _tag: "AnalysisInputError",
          operation,
          issues: [{ path: Object.keys(parameters), reason: "invalid_type" }],
        });
    }
    expect(producer.connects).toBe(0);
    expect(producer.calls).toEqual([]);
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    expect((await client.execute("list_strings", {})).ok).toBe(true);
    expect(
      (await client.execute("procedure_pseudo_code", { procedure: "main" })).ok,
    ).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "decompile_function"),
    ).toHaveLength(1);
    await client.close();
  });
});

describe("attached IDA function observations", () => {
  it("resolves interior addresses and call sites to canonical entries, preserves externals, and reports unknown body evidence", async () => {
    const { producer, client } = await fixture();
    const result = await client.execute("analyze_function", {
      procedure: "0x1004",
    });
    if (!result.ok) throw result.error;
    const dossier = functionDossierSchema.parse(result.value.result);
    expect(dossier.procedure.address).toBe("0x1000");
    expect(dossier.callers.map((caller) => caller.address)).toEqual(["0x1000"]);
    expect(dossier.callees.map((callee) => callee.address)).toEqual(["0x2000"]);
    expect(dossier.procedure.body.available).toBe(false);
    expect(dossier.comments).toEqual([]);
    expect(result.value.rawResult).toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({ tool: "get_callers" }),
      ]),
    });
    expect(result.value.provider.version).toBe("1");
    expect(producer.serverInfo()).toMatchObject({
      version: "sdk-version-is-not-ida",
    });
    await client.close();
    expect(producer.calls.some(({ name }) => name.startsWith("idb_"))).toBe(
      false,
    );
  });
  it("returns complete paged inventory and distinguishes literal from regex search", async () => {
    const { producer, client } = await fixture();
    producer.overrideCall = (name, args) =>
      name === "list_functions"
        ? {
            data: [
              {
                address: args.offset === 0 ? "0x1000" : "0x2000",
                name: "main",
                size: "0x10",
              },
            ],
            next_offset: args.offset === 0 ? 100 : null,
          }
        : undefined;
    const inventory = await client.execute("list_procedures", {});
    expect(inventory.ok && inventory.value.result).toHaveLength(2);
    for (const [pattern, mode, count] of [
      ["a.b", "literal", 1],
      ["a+b", "literal", 0],
      ["a.b", "regex", 1],
    ] as const) {
      const found = await client.execute("search_strings", { pattern, mode });
      expect(found.ok && found.value.result).toHaveLength(count);
    }
    expect(
      (await client.execute("search_strings", { pattern: "[", mode: "regex" }))
        .ok,
    ).toBe(false);
    await client.close();
  });
  it("rejects mismatched identities and target switches rather than returning a successful observation", async () => {
    const { producer, client, target } = await fixture();
    producer.inputSha256 = "a".repeat(64);
    const mismatch = await client.execute("health", {});
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.message).toContain("SHA-256");
    producer.inputSha256 = target.sha256;
    producer.beforeCall = async (name) => {
      if (name === "decompile_function") producer.imageBase = "0x2000";
    };
    const changed = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.message).toContain("changed");
    await client.close();
  });
  it("rejects malformed producer data, non-advancing cursors, unsupported mutation, and missing explicit addresses", async () => {
    const { producer, client } = await fixture();
    expect(
      (
        await client.execute("set_address_name", {
          address: "0x1000",
          name: "changed",
        })
      ).ok,
    ).toBe(false);
    expect(producer.connects).toBe(0);
    expect((await client.execute("xrefs", {})).ok).toBe(false);
    const invalidAddress = await client.execute("xrefs", {
      address: "not-an-address",
    });
    expect(invalidAddress.ok).toBe(false);
    if (!invalidAddress.ok)
      expect(invalidAddress.error._tag).toBe("AnalysisInputError");
    expect(producer.connects).toBe(0);
    producer.overrideCall = (name) =>
      name === "list_functions" ? { data: [], next_offset: 0 } : undefined;
    expect((await client.execute("list_procedures", {})).ok).toBe(false);
    producer.overrideCall = (name) =>
      name === "decompile_function" ? { unexpected: true } : undefined;
    const malformed = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error._tag).toBe("AnalysisOutputError");
    await client.close();
  });
  it("drains in-flight read-only work on cancellation before closing its proxy", async () => {
    const { producer, client } = await fixture();
    await client.execute("health", {});
    let release: (() => void) | undefined;
    let notify: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    producer.beforeCall = async (name) => {
      if (name === "decompile_function") {
        notify?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const controller = new AbortController();
    const call = client.execute(
      "procedure_pseudo_code",
      { procedure: "main" },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    const close = client.close();
    expect(producer.closes).toBe(0);
    release?.();
    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect((await close).ok).toBe(true);
    expect(producer.closes).toBe(1);
  });
});

const busyHealth = (busyTool?: JsonValue): JsonValue => ({
  status: "busy",
  uptime_sec: 1.041,
  ...(busyTool === undefined ? {} : { busy_tool: busyTool }),
  busy_sec: 0,
  queued_calls: 0,
});
const healthCalls = (producer: { calls: { name: string }[] }) =>
  producer.calls.filter(({ name }) => name === "server_health").length;

const expectCleanClose = async (
  producer: { closes: number },
  client: { close: () => Promise<{ ok: boolean }> },
): Promise<void> => {
  expect((await client.close()).ok, "the owned worker is released").toBe(true);
  expect(producer.closes, "the upstream connection is closed once").toBe(1);
};

describe("headless IDA transient busy health", () => {
  it("re-reads server_health until the worker reports ok", async () => {
    const { producer, client } = await fixture("headless");
    let busyReads = 2;
    producer.overrideCall = (name) =>
      name === "server_health" && busyReads-- > 0
        ? busyHealth("config_json_get")
        : undefined;

    const result = await client.execute("health", {});

    expect(result.ok, "a transient busy worker is waited out").toBe(true);
    expect(
      healthCalls(producer),
      "two busy reads and the ok read that settles the identity",
    ).toBe(3);
    await expectCleanClose(producer, client);
  });

  it("returns a retryable timeout naming the busy tool at the registration deadline", async () => {
    const { producer, client } = await fixture("headless", 300);
    const busy = busyHealth("config_json_get");
    producer.overrideCall = (name) =>
      name === "server_health" ? busy : undefined;
    const started = Date.now();

    const result = await client.execute("health", {});
    const elapsed = Date.now() - started;

    if (result.ok) throw new Error("expected a busy timeout");
    expect(result.error._tag, "the neutral timeout class is used").toBe(
      "AnalysisTimeoutError",
    );
    const projected = projectAnalysisError(result.error);
    expect(projected.code, "the outcome is a provider timeout").toBe(
      "provider_timeout",
    );
    expect(projected.retryable, "the caller may retry").toBe(true);
    expect(
      projected.details,
      "the observed busy tool is named exactly in the operation",
    ).toMatchObject({
      operation: "server_health: headless worker still busy in config_json_get",
      timeout_ms: 300,
    });
    expect(
      result.error.message,
      "the error message names the busy tool",
    ).toContain("config_json_get");
    expect(
      `${result.error.message} ${projected.message}`,
      "no Hopper wording leaks in",
    ).not.toContain("Hopper");
    expect(result.error.cause, "the raw busy payload is the cause").toEqual(
      busy,
    );
    expect(
      elapsed,
      "the wait runs to the deadline, not less",
    ).toBeGreaterThanOrEqual(290);
    expect(
      healthCalls(producer),
      "reads are spaced by the retry delay, not a tight loop",
    ).toBeLessThanOrEqual(6);
    await expectCleanClose(producer, client);
  });

  it("never invents a busy tool the worker did not report", async () => {
    const { producer, client } = await fixture("headless", 300);
    producer.overrideCall = (name) =>
      name === "server_health" ? busyHealth() : undefined;

    const result = await client.execute("health", {});

    if (result.ok) throw new Error("expected a busy timeout");
    expect(
      projectAnalysisError(result.error).details,
      "an omitted busy_tool is reported as exactly unknown",
    ).toMatchObject({
      operation: "server_health: headless worker still busy in unknown",
    });
    await expectCleanClose(producer, client);
  });

  it.each([
    ["free-form text", "token=abc123 /private/home/user secret"],
    ["an over-long name", "x".repeat(200)],
  ])(
    "reports %s from the worker as unknown instead of echoing it",
    async (_label, tool) => {
      const { producer, client } = await fixture("headless", 300);
      producer.overrideCall = (name) =>
        name === "server_health" ? busyHealth(tool) : undefined;

      const result = await client.execute("health", {});

      if (result.ok) throw new Error("expected a busy timeout");
      expect(
        projectAnalysisError(result.error).details,
        "only a tool-name-shaped value is repeated",
      ).toMatchObject({
        operation: "server_health: headless worker still busy in unknown",
      });
      expect(
        result.error.message,
        "the producer text never reaches the error message",
      ).not.toContain(tool);
      await expectCleanClose(producer, client);
    },
  );

  it("ends the wait at once when the caller aborts", async () => {
    const { producer, client } = await fixture("headless", 30_000);
    producer.overrideCall = (name) =>
      name === "server_health" ? busyHealth("config_json_get") : undefined;
    const controller = new AbortController();
    const started = Date.now();
    const call = client.execute("health", {}, { signal: controller.signal });
    while (healthCalls(producer) < 2) {
      if (Date.now() - started > 5_000) throw new Error("never polled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    controller.abort();
    const result = await call;

    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag, "cancellation keeps today's outcome").toBe(
      "AnalysisCancelledError",
    );
    expect(
      Date.now() - started,
      "the wait does not run to the registration deadline",
    ).toBeLessThan(5_000);
    await expectCleanClose(producer, client);
  });
});

describe("headless IDA busy health after an operation", () => {
  const withInventory = (
    producer: RecordingIdaMcp,
    afterObservation: (read: number) => JsonValue | undefined,
  ) => {
    let health = 0;
    producer.overrideCall = (name) => {
      if (name === "list_funcs")
        return [
          {
            data: [{ addr: "0x1000", name: "main", size: "0x20" }],
            next_offset: null,
          },
        ];
      if (name !== "server_health") return undefined;
      health += 1;
      return health < 2 ? undefined : afterObservation(health);
    };
  };

  it("waits out a busy observation taken after the operation", async () => {
    const { producer, client } = await fixture("headless");
    withInventory(producer, (read) =>
      read === 2 ? busyHealth("config_json_get") : undefined,
    );

    const result = await client.execute("list_procedures", {});

    expect(result.ok, "the operation succeeds once the worker settles").toBe(
      true,
    );
    expect(healthCalls(producer), "before, busy after, ok after").toBe(3);
    await expectCleanClose(producer, client);
  });

  it("maps a cancellation during that wait to cancelled", async () => {
    const { producer, client } = await fixture("headless", 30_000);
    withInventory(producer, () => busyHealth("config_json_get"));
    const controller = new AbortController();
    const call = client.execute(
      "list_procedures",
      {},
      { signal: controller.signal },
    );
    const started = Date.now();
    while (healthCalls(producer) < 3) {
      if (Date.now() - started > 5_000) throw new Error("never polled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    controller.abort();
    const result = await call;

    if (result.ok) throw new Error("expected cancellation");
    expect(result.error._tag, "the after-observation wait is cancellable").toBe(
      "AnalysisCancelledError",
    );
    await expectCleanClose(producer, client);
  });
});

describe("headless IDA non-busy health payloads", () => {
  it.each([
    ["an unknown status", { status: "starting" }],
    ["a non-string busy_tool", busyHealth(5)],
    ["a payload without a status", { uptime_sec: 1 }],
  ])(
    "keeps %s as unreadable output without waiting",
    async (_label, payload) => {
      const { producer, client } = await fixture("headless");
      producer.overrideCall = (name) =>
        name === "server_health" ? jsonValueSchema.parse(payload) : undefined;

      const result = await client.execute("health", {});

      if (result.ok) throw new Error("expected unreadable output");
      expect(
        projectAnalysisError(result.error).code,
        "only the narrow busy shape enters the wait",
      ).toBe("unreadable_output");
      expect(healthCalls(producer), "no re-read happened").toBe(1);
      await expectCleanClose(producer, client);
    },
  );

  it("keeps the busy-shape reason when a busy payload is invalid", async () => {
    const { producer, client } = await fixture("headless");
    producer.overrideCall = (name) =>
      name === "server_health" ? busyHealth(5) : undefined;

    const result = await client.execute("health", {});

    if (result.ok) throw new Error("expected unreadable output");
    expect(
      projectAnalysisError(result.error).details,
      "the diagnostic names the invalid busy_tool, not the ok-schema fields",
    ).toMatchObject({ reason: expect.stringContaining("busy_tool") });
    expect(
      JSON.stringify(projectAnalysisError(result.error).details),
      "the generic ok-schema field errors are not reported for a busy payload",
    ).not.toContain("input_path");
    await expectCleanClose(producer, client);
  });

  it("stops waiting as soon as a later read is malformed", async () => {
    const { producer, client } = await fixture("headless");
    let reads = 0;
    producer.overrideCall = (name) =>
      name === "server_health"
        ? reads++ === 0
          ? busyHealth("config_json_get")
          : busyHealth(5)
        : undefined;

    const result = await client.execute("health", {});

    if (result.ok) throw new Error("expected unreadable output");
    expect(
      projectAnalysisError(result.error).code,
      "a malformed re-read is not treated as busy",
    ).toBe("unreadable_output");
    expect(
      healthCalls(producer),
      "exactly the busy read and the bad read",
    ).toBe(2);
    await expectCleanClose(producer, client);
  });
});

describe("headless IDA lifecycle boundaries", () => {
  it("never closes an unowned worker even when open echoes the requested private identity", async () => {
    const { producer, client } = await fixture("headless");
    producer.owned = false;
    expect((await client.execute("health", {})).ok).toBe(false);
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(true);
    expect(producer.calls.some(({ name }) => name === "idb_close")).toBe(false);
  });
});

describe("headless IDA session ownership and cleanup", () => {
  it("shares an in-flight close across concurrent cleanup callers", async () => {
    const { producer, client } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);

    let release: (() => void) | undefined;
    let notify: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      notify = resolve;
    });
    producer.beforeCall = async (name) => {
      if (name !== "idb_close") return;
      notify?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const first = client.close();
    await closeStarted;
    const second = client.close();
    release?.();
    const results = await Promise.all([first, second]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "idb_close"),
    ).toHaveLength(1);
    expect(producer.closes).toBe(1);
  });

  it("retains the workspace after an unconfirmed open, even when inventory is empty, and never retries startup implicitly", async () => {
    const { producer, client, root } = await fixture("headless");
    producer.beforeCall = async (name) => {
      if (name === "idb_open")
        throw new Error("Timed out while the worker may still be opening");
    };
    expect((await client.execute("health", {})).ok).toBe(false);
    expect((await client.execute("health", {})).ok).toBe(false);
    expect(
      producer.calls.filter(({ name }) => name === "idb_open"),
    ).toHaveLength(1);
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(true);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
    expect(producer.closes).toBe(0);
  });
  it("opens a private digest-verified copy, scopes requests, closes without saving, and removes only its workspace", async () => {
    const { producer, client, root, target } = await fixture("headless");
    const original = await readFile(target.path);
    const result = await client.execute("analyze_function", {
      procedure: "main",
    });
    if (!result.ok) throw result.error;
    expect(producer.inputPath).not.toBe(target.path);
    expect(await readFile(producer.inputPath)).toEqual(original);
    expect(
      functionDossierSchema
        .parse(result.value.result)
        .limitations.some((value) => value.includes("Direct callers")),
    ).toBe(true);
    const open = producer.calls.find(({ name }) => name === "idb_open");
    expect(open?.args).toMatchObject({
      mode: "force_headless",
      run_auto_analysis: true,
    });
    for (const call of producer.calls.filter(
      ({ name }) => !["idb_open", "idb_list"].includes(name),
    ))
      expect(call.args.database).toBe(producer.database);
    expect((await client.close()).ok).toBe(true);
    expect(
      producer.calls.find(({ name }) => name === "idb_close")?.args.save,
    ).toBe(false);
    expect(await readdir(root)).toEqual(["target.elf"]);
    expect(await readFile(target.path)).toEqual(original);
  });
  it("retains the private workspace and reports cleanup failure when worker release is unverified", async () => {
    const { producer, client, root } = await fixture("headless");
    await client.execute("health", {});
    producer.failClose = true;
    const result = await client.close();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cleanupIncomplete).toBe(true);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
  });
});

describe("headless IDA reaped worker cleanup", () => {
  it("recovers a reaped worker only after inventory confirms its session and private input are absent", async () => {
    const { producer, client, root } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);
    const sessionId = producer.database;
    producer.beforeCall = async (name) => {
      if (name === "idb_close") producer.database = undefined;
    };
    producer.overrideCall = (name) =>
      name === "idb_close"
        ? { error: `Session not found: ${sessionId}` }
        : undefined;

    expect((await client.close()).ok).toBe(true);
    expect(producer.calls.map(({ name }) => name).slice(-2)).toEqual([
      "idb_close",
      "idb_list",
    ]);
    expect(producer.closes).toBe(1);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });

  it("retains resources when an absent-session close is followed by a live private-input peer", async () => {
    const { producer, client, root } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);
    const sessionId = producer.database;
    producer.beforeCall = async (name) => {
      if (name === "idb_close") producer.database = undefined;
      if (name === "idb_list" && producer.database === undefined) {
        producer.database = "unrelated-live-peer";
        producer.owned = false;
      }
    };
    producer.overrideCall = (name) =>
      name === "idb_close"
        ? { error: `Session not found: ${sessionId}` }
        : undefined;

    const result = await client.close();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cleanupIncomplete).toBe(true);
    expect(producer.closes).toBe(0);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
  });

  it("retries independent inventory verification after an absent-session response", async () => {
    const { producer, client, root } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);
    const sessionId = producer.database;
    let inventoryUnavailable = true;
    producer.beforeCall = async (name) => {
      if (name === "idb_close") producer.database = undefined;
      if (name === "idb_list" && inventoryUnavailable) {
        inventoryUnavailable = false;
        throw new Error("Inventory temporarily unavailable");
      }
    };
    producer.overrideCall = (name) =>
      name === "idb_close"
        ? { error: `Session not found: ${sessionId}` }
        : undefined;

    expect((await client.close()).ok).toBe(false);
    expect(producer.closes).toBe(0);
    expect((await client.close()).ok).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "idb_close"),
    ).toHaveLength(1);
    expect(producer.closes).toBe(1);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });

  it("does not treat a different missing session identity as proof of release", async () => {
    const { producer, client, root } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);
    producer.beforeCall = async (name) => {
      if (name === "idb_close") producer.database = undefined;
    };
    producer.overrideCall = (name) =>
      name === "idb_close"
        ? { error: "Session not found: another-session" }
        : undefined;

    const result = await client.close();
    expect(result.ok).toBe(false);
    expect(
      producer.calls.filter(({ name }) => name === "idb_list"),
    ).toHaveLength(1);
    expect(producer.closes).toBe(0);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
  });
});

describe("headless IDA cleanup verification", () => {
  it("retries failed worker release through the retained connection before removing its workspace", async () => {
    const { producer, client, root } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);
    producer.failClose = true;
    expect((await client.close()).ok).toBe(false);
    expect(producer.closes).toBe(0);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
    producer.failClose = false;
    expect((await client.close()).ok).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "idb_close"),
    ).toHaveLength(2);
    expect(producer.closes).toBe(1);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });
  it("retries post-close inventory verification without closing an already released database again", async () => {
    const { producer, client, root } = await fixture("headless");
    expect((await client.execute("health", {})).ok).toBe(true);
    let inventoryFails = true;
    producer.beforeCall = async (name) => {
      if (
        name === "idb_list" &&
        producer.database === undefined &&
        inventoryFails
      )
        throw new Error(
          "Worker inventory unavailable after acknowledged close",
        );
    };
    expect((await client.close()).ok).toBe(false);
    expect(producer.closes).toBe(0);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
    inventoryFails = false;
    expect((await client.close()).ok).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "idb_close"),
    ).toHaveLength(1);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });
  it("never closes an unrelated database when startup returns a different input identity", async () => {
    const { producer, client, root } = await fixture("headless");
    producer.overrideCall = (name) =>
      name === "idb_open"
        ? {
            success: true,
            session: {
              session_id: "user-database",
              input_path: "/unrelated/input",
            },
          }
        : undefined;
    expect((await client.execute("health", {})).ok).toBe(false);
    expect((await client.close()).ok).toBe(true);
    expect(producer.calls.some(({ name }) => name === "idb_close")).toBe(false);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });
  it("releases a privately owned worker after malformed open output using verified session inventory", async () => {
    const { producer, client, root } = await fixture("headless");
    producer.beforeCall = async (name, args) => {
      if (name === "idb_open") {
        producer.database = z.string().parse(args.preferred_session_id);
        producer.inputPath = z.string().parse(args.input_path);
      }
    };
    producer.overrideCall = (name) =>
      name === "idb_open"
        ? jsonValueSchema.parse({
            success: true,
            session: { session_id: producer.database },
          })
        : undefined;
    expect((await client.execute("health", {})).ok).toBe(false);
    expect((await client.close()).ok).toBe(true);
    expect(
      producer.calls.find(({ name }) => name === "idb_close")?.args.database,
    ).toMatch(/^rea-/u);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });
});
