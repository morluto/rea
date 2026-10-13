import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AngrSessionClient } from "../../src/angr/AngrSessionClient.js";
import { readAngrConfiguration } from "../../src/angr/AngrConfiguration.js";
import { createAngrTarget, RecordingAngrMcp } from "../fixtures/angrMcp.js";
import {
  nativeDecompilationEditsSchema,
  nativeDecompilationFlavorSchema,
} from "../../src/domain/native/nativeDecompilationEdits.js";
import { nativeFunctionAnnotationsSchema } from "../../src/domain/native/nativeFunctionAnnotations.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const configuration = (flavor?: string) => {
  const parsed = readAngrConfiguration({ pythonPath: process.execPath });
  if (!parsed.ok) throw parsed.error;
  return flavor === undefined ? parsed.value : { ...parsed.value, flavor };
};
const open = async (flavor?: string) => {
  const { root, target } = await createAngrTarget();
  roots.push(root);
  const producer = new RecordingAngrMcp(target);
  const client = new AngrSessionClient(configuration(flavor), target, producer);
  return { producer, client };
};
const unwrap = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
  if (!result.ok) throw result.error;
  return result.value as T;
};

describe("angr knowledge-base edits", () => {
  it("names a function entry as a function and any other address as a global", async () => {
    const { producer, client } = await open();
    try {
      expect(
        unwrap(
          await client.execute("set_address_name", {
            address: "0x1000",
            name: "entry",
          }),
        ).result,
      ).toBe(true);
      expect(producer.names.get("0x1000")).toBe("entry");
      expect(
        producer.calls.filter(({ name }) => name === "rename").at(-1)?.args,
      ).toMatchObject({
        items: [{ kind: "function", address: "0x1000", new_name: "entry" }],
      });
      const batch = unwrap(
        await client.execute("set_addresses_names", {
          names: { "0x1040": "helper_renamed", "0x3000": "greeting" },
        }),
      ).result;
      expect(batch).toEqual({ "0x1040": true, "0x3000": true });
      expect(producer.calls.at(-1)?.args).toMatchObject({
        items: [
          { kind: "function", address: "0x1040" },
          { kind: "global", address: "0x3000" },
        ],
      });
      // Renames invalidate the cached call graph so names stay current.
      await client.execute("procedure_callers", { procedure: "0x1000" });
      await client.execute("set_address_name", {
        address: "0x1040",
        name: "helper2",
      });
      const callers = unwrap(
        await client.execute("analyze_function", { procedure: "0x1000" }),
      );
      expect(
        producer.calls.filter(({ name }) => name === "get_callgraph"),
      ).toHaveLength(2);
      expect(callers.result).toMatchObject({ procedure: { name: "entry" } });
    } finally {
      await client.close();
    }
  });
  it("writes comments, annotates functions, and rejects inline comments", async () => {
    const { producer, client } = await open();
    try {
      expect(
        unwrap(
          await client.execute("set_comment", {
            address: "0x1004",
            comment: "checked",
          }),
        ).result,
      ).toBe(true);
      expect(producer.comments.get("0x1004")).toBe("checked");
      const annotated = unwrap(
        await client.execute("annotate_native_function", {
          procedure: "main",
          name: "entry",
          comment: "entry point",
        }),
      );
      const parsed = nativeFunctionAnnotationsSchema.parse(annotated.result);
      expect(parsed.annotations).toEqual({
        address: "0x1000",
        name: "entry",
        comment: "entry point",
        inline_comment: null,
      });
      expect(parsed.dossier.procedure.name).toBe("entry");
      expect(producer.comments.get("0x1000")).toBe("entry point");
      const inline = await client.execute("annotate_native_function", {
        procedure: "entry",
        inline_comment: "x",
      });
      expect(inline.ok).toBe(false);
      if (!inline.ok) expect(inline.error._tag).toBe("AnalysisInputError");
      const missing = await client.execute("annotate_native_function", {
        procedure: "absent",
        name: "x",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error._tag).toBe("AnalysisInputError");
    } finally {
      await client.close();
    }
  });
});

describe("angr batch edits and decompilation flavor", () => {
  it("batches variable renames, retypes, and prototypes with per-item outcomes", async () => {
    const { producer, client } = await open();
    try {
      const renamed = nativeDecompilationEditsSchema.parse(
        unwrap(
          await client.execute("rename_native_variables", {
            items: [
              { procedure: "main", variable: "v0", new_name: "username" },
              { procedure: "main", variable: "absent_variable", new_name: "x" },
              { procedure: "absent", variable: "v1", new_name: "y" },
            ],
          }),
        ).result,
      );
      expect(renamed).toMatchObject({
        total: 3,
        succeeded: 1,
        failed: 2,
        functions_affected: ["0x1000"],
        effects: { source_bytes_modified: false, persists_after_close: false },
      });
      expect(renamed.results[0]).toMatchObject({
        status: "ok",
        procedure: { address: "0x1000", name: "main" },
        old: "v0",
        new: "username",
        detail: { storage: "stack" },
      });
      expect(renamed.results[1]?.error).toContain("absent_variable");
      expect(producer.calls.at(-1)?.args).toMatchObject({
        auto_decompile: true,
        allow_overwrite: false,
        dry_run: false,
      });
      const typed = nativeDecompilationEditsSchema.parse(
        unwrap(
          await client.execute("set_native_variable_types", {
            items: [
              { procedure: "main", variable: "username", type: "char *" },
              { address: "0x3000", type: "char[11]" },
            ],
            redecompile: true,
          }),
        ).result,
      );
      expect(
        typed.results.map(({ status, new: value }) => [status, value]),
      ).toEqual([
        ["ok", "char *"],
        ["ok", "char[11]"],
      ]);
      expect(producer.calls.at(-1)?.args).toMatchObject({
        redecompile: true,
        items: [{ kind: "variable" }, { kind: "global", address: "0x3000" }],
      });
      const protos = nativeDecompilationEditsSchema.parse(
        unwrap(
          await client.execute("set_native_function_prototypes", {
            items: [
              {
                procedure: "main",
                signature: "int main(int argc, char **argv, char **envp)",
              },
              { procedure: "helper", return_type: "void" },
            ],
            dry_run: true,
          }),
        ).result,
      );
      expect(protos.dry_run).toBe(true);
      expect(producer.calls.at(-1)?.args).toMatchObject({
        dry_run: true,
        items: [{ kind: "function" }, { kind: "return", type: "void" }],
      });
    } finally {
      await client.close();
    }
  });
  it("inspects and sets the decompilation flavor and applies a configured default", async () => {
    const { producer, client } = await open("go");
    try {
      const inspected = nativeDecompilationFlavorSchema.parse(
        unwrap(await client.execute("inspect_native_decompilation_flavor", {}))
          .result,
      );
      expect(inspected).toMatchObject({
        flavor: "go",
        previous_flavor: null,
        available_flavors: ["pseudocode", "rust", "go"],
        detected_language: "c",
      });
      expect(producer.flavor).toBe("go");
      const changed = nativeDecompilationFlavorSchema.parse(
        unwrap(
          await client.execute("set_native_decompilation_flavor", {
            flavor: "rust",
          }),
        ).result,
      );
      expect(changed).toMatchObject({ flavor: "rust", previous_flavor: "go" });
      const health = unwrap(await client.execute("health", {}));
      expect(health.result).toMatchObject({ decompilation_flavor: "rust" });
      const invalid = await client.execute("set_native_decompilation_flavor", {
        flavor: "cobol",
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error._tag).toBe("AnalysisInputError");
      expect(producer.flavor).toBe("rust");
    } finally {
      await client.close();
    }
  });
});

describe("angr without decompilation-flavor tools", () => {
  it("reports flavor operations unavailable on an angr without flavor tools", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const producer = new RecordingAngrMcp(target);
    producer.tools = [
      "load_binary",
      "get_cfg",
      "list_functions",
      "get_function_info",
      "decompile_function",
      "get_xrefs",
      "get_strings",
      "get_basic_blocks",
      "get_callgraph",
      "close_project",
      "rename",
      "set_type",
      "set_comments",
    ];
    const client = new AngrSessionClient(configuration(), target, producer);
    try {
      const result = await client.execute(
        "inspect_native_decompilation_flavor",
        {},
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(
        unwrap(await client.execute("procedure_address", { procedure: "main" }))
          .result,
      ).toBe("0x1000");
    } finally {
      await client.close();
    }
    const configured = new AngrSessionClient(
      configuration("rust"),
      target,
      producer,
    );
    try {
      const startup = await configured.execute("procedure_address", {
        procedure: "main",
      });
      expect(startup.ok).toBe(false);
      if (!startup.ok) expect(startup.error.message).toContain("flavor");
    } finally {
      await configured.close();
    }
  });
});
