import { readFile, readdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async (mode: "attached" | "headless" = "attached") => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target, mode);
  const client = new IdaSessionClient(
    {
      command: "fixture",
      args: [],
      env: {},
      mode,
      timeoutMs: 1000,
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
    await client.close();
  });
});

describe("attached IDA observation semantics", () => {
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
  it("accepts MCP's null projection for omitted optional fields without accepting null required fields", async () => {
    const { producer, client } = await fixture();
    expect(
      (await client.execute("list_procedures", { document: null })).ok,
    ).toBe(true);
    expect(
      (await client.execute("list_strings", { document: null, address: null }))
        .ok,
    ).toBe(true);
    expect(
      (
        await client.execute("procedure_pseudo_code", {
          document: null,
          procedure: "main",
        })
      ).ok,
    ).toBe(true);
    const required = await client.execute("procedure_pseudo_code", {
      document: null,
      procedure: null,
    });
    expect(required.ok).toBe(false);
    if (!required.ok) expect(required.error._tag).toBe("AnalysisInputError");
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
    expect(result.ok).toBe(true);
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
    const close = client.closeWithOutcome();
    expect(producer.closes).toBe(0);
    release?.();
    const result = await call;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect((await close).ok).toBe(true);
    expect(producer.closes).toBe(1);
  });
});

describe("headless IDA lifecycle boundaries", () => {
  it("never closes an unowned worker even when open echoes the requested private identity", async () => {
    const { producer, client } = await fixture("headless");
    producer.owned = false;
    expect((await client.execute("health", {})).ok).toBe(false);
    const closed = await client.closeWithOutcome();
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(true);
    expect(producer.calls.some(({ name }) => name === "idb_close")).toBe(false);
  });
});

describe("headless IDA session ownership and cleanup", () => {
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
    const closed = await client.closeWithOutcome();
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(true);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
    expect(producer.closes).toBe(1);
  });
  it("opens a private digest-verified copy, scopes requests, closes without saving, and removes only its workspace", async () => {
    const { producer, client, root, target } = await fixture("headless");
    const original = await readFile(target.path);
    const result = await client.execute("analyze_function", {
      procedure: "main",
    });
    expect(result.ok).toBe(true);
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
    expect((await client.closeWithOutcome()).ok).toBe(true);
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
    const result = await client.closeWithOutcome();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cleanupIncomplete).toBe(true);
    expect(
      (await readdir(root)).some((name) => name.startsWith("rea-ida-")),
    ).toBe(true);
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
    expect((await client.closeWithOutcome()).ok).toBe(true);
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
    expect((await client.closeWithOutcome()).ok).toBe(true);
    expect(
      producer.calls.find(({ name }) => name === "idb_close")?.args.database,
    ).toMatch(/^rea-/u);
    expect(await readdir(root)).toEqual(["target.elf"]);
  });
});
