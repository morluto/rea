import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as ownedRegularFile from "../filesystem/OwnedRegularFile.js";
import { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import {
  LEANDEC_DOCTOR_SETTINGS,
  inspectLeandecProvider,
} from "./LeandecDoctor.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { LeandecProvider } from "./LeandecProvider.js";

const fixture = `
const readline = require("node:readline");
const rl = readline.createInterface({input: process.stdin});
const target = {key:"fixture", slice_sha256:process.env.FIXTURE_SHA, arch:"x86_64", functions:2, slice:process.env.FIXTURE_PATH};
const reply = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result}) + "\\n");
rl.on("line", line => {
  const r = JSON.parse(line);
  if (r.method === "initialize") return reply(r.id,{protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"fixture",version:"1.0.0"}});
  if (r.method !== "tools/call") return;
  const {name,arguments:a} = r.params;
  let result;
  if (name === "targets") result = [target];
  else if (name === "overview") result = target;
  else if (name === "sql") {
    if (a.query.includes("COUNT(*)")) result = {rows:[[2]]};
    else if (a.query.includes("ltrim")) result = {rows:[["00002000","fade","",8]]};
    else if (a.query.includes("name = 'fade'")) result = {rows:[["00002000","fade","",8]]};
    else result = {rows:[["00001000","entry","",4]]};
  } else if (name === "decompile" && a.selector === "00002000") result = {pseudocode:"return 1;",cached:true};
  else if (name === "sections") result = {sections:[]};
  else if (name === "read_bytes") result = {address:"100000000", length:2, dump:"100000000 aa bb |..|"};
  else if (name === "strings") result = {items:[{address:"00003000",value:"hello"}],total_strings:3};
  else return reply(r.id,{isError:true,content:[{type:"text",text:"unexpected fixture request: "+name}]});
  const send = () => reply(r.id,{content:[{type:"text",text:JSON.stringify(result)}]});
  if (process.env.FIXTURE_DELAY === "1" && name === "sql") setTimeout(send, 350); else send();
});
`;

const make = async (overrides: NodeJS.ProcessEnv = {}) => {
  const root = await createTestTempDirectory("leandec-session-");
  const path = join(root, "sample");
  const server = join(root, "server.cjs");
  const bytes = Buffer.from("fixture-binary");
  await writeFile(path, bytes);
  await writeFile(server, fixture);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const provider = new LeandecProvider({
    ...process.env,
    LEANDEC_MCP_SERVER: server,
    LEANDEC_PYTHON: process.execPath,
    LEANDEC_AUTO_ANALYZE: "0",
    LEANDEC_INVENTORY_LIMIT: "1",
    FIXTURE_SHA: sha256,
    FIXTURE_PATH: path,
    ...overrides,
  });
  const target = {
    path,
    sha256,
    kind: "executable" as const,
    format: "elf" as const,
    architecture: "x86_64" as const,
    availableArchitectures: ["x86_64" as const],
  };
  return { client: provider.createClient(target), path, server };
};

describe.skipIf(process.platform === "win32")(
  "Leandec analysis through stdio",
  () => {
    it("keeps lookup spelling, returns public addresses, and reports capped searches", async () => {
      const { client } = await make();
      try {
        const inventory = await client.execute("list_procedures", {});
        expect(inventory).toMatchObject({
          ok: true,
          value: {
            result: [{ address: "0x1000", value: "entry" }],
            limitations: expect.arrayContaining([
              expect.stringContaining("1 of 2"),
            ]),
          },
        });
        const named = await client.execute("procedure_address", {
          procedure: "fade",
        });
        expect(named).toMatchObject({ ok: true, value: { result: "0x2000" } });
        const direct = await client.execute("procedure_pseudo_code", {
          procedure: "0x2000",
        });
        expect(direct).toMatchObject({
          ok: true,
          value: { result: "return 1;" },
        });
        const strings = await client.execute("search_strings", {
          pattern: "hell",
          mode: "literal",
          case_sensitive: false,
        });
        expect(strings).toMatchObject({
          ok: true,
          value: {
            result: [{ address: "0x3000", value: "hello" }],
            limitations: expect.arrayContaining([
              expect.stringContaining("1 of 3"),
            ]),
          },
        });
        const bytes = await client.execute("read_bytes", {
          address: "0x100000000",
          length: 2,
        });
        expect(bytes).toMatchObject({
          ok: true,
          value: {
            result: {
              address: "0x100000000",
              bytes_hex: "aabb",
              complete: true,
            },
          },
        });
      } finally {
        expect(await client.close()).toEqual({ ok: true, value: null });
      }
    });

    it("retains an unconfirmed process close until a retry succeeds", async () => {
      const { client } = await make();
      const stop = vi.spyOn(ProviderProcessSupervisor.prototype, "stop");
      try {
        expect((await client.execute("list_procedures", {})).ok).toBe(true);
        stop.mockResolvedValueOnce({
          status: "incomplete",
          reason: "fixture cleanup failure",
        });
        const first = await client.close();
        expect(first).toMatchObject({
          ok: false,
          error: { cleanupIncomplete: true },
        });
        expect(client.reuseReadiness?.()).toBe("blocked");
        expect(await client.close()).toEqual({ ok: true, value: null });
        if (!first.ok) expect(first.error.cleanupIncomplete).toBe(false);
        expect(stop).toHaveBeenCalledTimes(2);
      } finally {
        stop.mockRestore();
        await client.close();
      }
    });

    it("blocks replacement startup after an unconfirmed file close", async () => {
      const { client } = await make();
      const original = ownedRegularFile.withOwnedFileHandle;
      const close = vi.spyOn(ownedRegularFile, "withOwnedFileHandle").mockImplementation(
        async (path, owner, options, operation) => {
          if (!path.endsWith("/input") || !path.includes("rea-leandec-"))
            return original(path, owner, options, operation);
          const descriptor = vi.spyOn(owner, "close").mockRejectedValueOnce(new Error("fixture descriptor close failure"));
          try {
            return await original(path, owner, options, operation);
          } finally {
            descriptor.mockRestore();
          }
        },
      );
      try {
        const first = await client.execute("list_procedures", {});
        expect(first).toMatchObject({ ok: false, error: { cleanupIncomplete: true } });
        expect(client.reuseReadiness?.()).toBe("blocked");
        const next = await client.execute("list_procedures", {});
        if (!first.ok && !next.ok) expect(next.error).toBe(first.error);
        else throw new Error("Expected retained cleanup failure");
        expect(await client.close()).toEqual({ ok: true, value: null });
        if (!first.ok) expect(first.error.cleanupIncomplete).toBe(false);
      } finally {
        close.mockRestore();
        await client.close();
      }
    });

    it("keeps the original operation and abort reason when waiting for shared inventory", async () => {
      const { client } = await make({ FIXTURE_DELAY: "1" });
      try {
        expect((await client.execute("health", {})).ok).toBe(true);
        const cancellation = new AbortController();
        const first = client.execute(
          "list_procedures",
          {},
          { signal: cancellation.signal },
        );
        const second = client.execute("list_procedures", {});
        const reason = new Error("fixture caller cancellation");
        setTimeout(() => cancellation.abort(reason), 30);
        const result = await first;
        expect(result).toMatchObject({
          ok: false,
          error: { operation: "list_procedures", cause: reason },
        });
        expect((await second).ok).toBe(true);
      } finally {
        await client.close();
      }
    });

    it("preserves unexpected write failure diagnostics", async () => {
      const { client } = await make();
      const failure = Object.assign(new Error("fixture ENOSPC"), {
        code: "ENOSPC",
      });
      const original = ownedRegularFile.withOwnedFileHandle;
      const spy = vi.spyOn(ownedRegularFile, "withOwnedFileHandle").mockImplementation(
        async (path, owner, options, operation) => {
          if (!path.endsWith("/input") || !path.includes("rea-leandec-"))
            return original(path, owner, options, operation);
          await owner.close();
          throw failure;
        },
      );
      try {
        const result = await client.execute("list_procedures", {});
        expect(result).toMatchObject({
          ok: false,
          error: { cause: failure, diagnostics: { reason: "fixture ENOSPC" } },
        });
      } finally {
        spy.mockRestore();
        await client.close();
      }
    });

    it("declares every configuration input used by doctor and rejects invalid settings", async () => {
      const { client, server } = await make();
      try {
        for (const name of [
          "LEANDEC_CALL_TIMEOUT_MS",
          "LEANDEC_IMPORT_TIMEOUT_MS",
          "LEANDEC_INVENTORY_LIMIT",
          "LEANDEC_STRING_LIMIT",
          "LEANDEC_AUTO_ANALYZE",
        ] as const) {
          expect(LEANDEC_DOCTOR_SETTINGS).toContain(name);
          const doctor = inspectLeandecProvider(
            {
              ...process.env,
              LEANDEC_MCP_SERVER: server,
              LEANDEC_PYTHON: process.execPath,
              [name]: "-1",
            },
            process.platform,
          );
          expect(doctor.available).toBe(false);
        }
      } finally {
        await client.close();
      }
    });

    it("rejects bytes changed after target admission", async () => {
      const { client, path } = await make();
      try {
        await writeFile(path, "changed");
        const result = await client.execute("list_procedures", {});
        expect(result.ok).toBe(false);
      } finally {
        expect(await client.close()).toEqual({ ok: true, value: null });
      }
    });
  },
);
