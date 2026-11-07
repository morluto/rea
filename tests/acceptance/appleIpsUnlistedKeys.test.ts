import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";

const reportText = (
  thread: string,
  frame: string,
  image: string,
  malformedRows = false,
) => {
  const rows = malformedRows ? ",null,{}" : "";
  const frames = malformedRows ? ",null" : "";
  return `{"bug_type":"309","unknownMetadata":0}\n{"unknownBody":0,"faultingThread":0,"threads":[{${thread}"id":1,"frames":[{${frame}"imageIndex":0,"imageOffset":8,"symbol":"fixture_fault"}${frames}]}${rows}],"usedImages":[{${image}"arch":"arm64","base":4294967296,"uuid":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}${rows}]}`;
};

cliTest(
  "retains immediate IPS row key names through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ips-unlisted-");
    const path = join(root, "report.ips");
    const bytes = reportText(
      '"unknownThread":{"hiddenThread":"VERIFY_THREAD"},"":null,',
      '"\\u0075nknownFrame":[{"hiddenFrame":"VERIFY_FRAME"}],',
      '"unknownImage":"VERIFY_IMAGE","__proto__":0,',
      true,
    );
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-apple-ips", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected stdio MCP session");
    const mcp = await call("inspect_apple_ips", { path });
    expect(mcp.isError, JSON.stringify(mcp.content)).not.toBe(true);
    for (const reply of [result.json, mcp.structuredContent]) {
      const report =
        toolContract("inspect_apple_ips").outputSchema.parse(
          reply,
        ).normalized_result;
      expect(report.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(report.metadata.unlisted_keys).toEqual(["unknownMetadata"]);
      expect(report.unlisted_body_keys).toEqual(["unknownBody"]);
      expect(report.threads[0]).toMatchObject({
        id: { decimal: "1", hex: "0x1" },
        unlisted_keys: ["unknownThread", ""],
        frames: [
          {
            unlisted_keys: ["unknownFrame"],
            recorded_symbol: "fixture_fault",
            runtime_address: { decimal: "4294967304", hex: "0x100000008" },
          },
          { unlisted_keys: [] },
        ],
      });
      expect(report.images[0]).toMatchObject({
        unlisted_keys: ["unknownImage", "__proto__"],
        uuid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      });
      for (const index of [1, 2]) {
        expect(report.threads[index]).toMatchObject({ unlisted_keys: [] });
        expect(report.images[index]).toMatchObject({ unlisted_keys: [] });
      }
      expect(report.coverage).toMatchObject({
        status: "partial",
        threads: 3,
        frames: 2,
        images: 3,
      });
      expect(report.coverage.type_mismatches.map(({ path }) => path)).toEqual(
        expect.arrayContaining([
          "body.threads[0].frames[1]",
          "body.threads[1]",
          "body.usedImages[1]",
        ]),
      );
      const serialized = JSON.stringify(reply);
      for (const value of ["VERIFY_", "hiddenThread", "hiddenFrame"])
        expect(serialized).not.toContain(value);
    }
  },
);

cliTest.for(["thread", "frame", "image"] as const)(
  "bounds retained IPS %s key names per row through CLI and stdio MCP",
  async (kind, { cli }) => {
    const root = await createTestTempDirectory("rea-ips-key-limit-");
    const path = join(root, "report.ips");
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected stdio MCP session");
    for (const count of [1024, 1025]) {
      const keys = Array.from({ length: count }, (_, i) => `key${String(i)}`);
      const members = keys
        .map((key) => `${JSON.stringify(key)}:null,`)
        .join("");
      await writeFile(
        path,
        reportText(
          kind === "thread" ? members : "",
          kind === "frame" ? members : "",
          kind === "image" ? members : "",
        ),
      );
      const result = await cli.run({
        arguments: ["inspect-apple-ips", path, "--json"],
      });
      const mcp = await call("inspect_apple_ips", { path });
      expect(result.exitCode, result.stderr).toBe(count === 1024 ? 0 : 1);
      expect(mcp.isError ?? false).toBe(count === 1025);
      if (count === 1025) {
        expect(result.json).toMatchObject({
          code: "resource_constraint",
          details: {
            reported_limits: { boundary: "unlisted_keys", maximum: 1024 },
          },
        });
        expect(parseMcpToolError(mcp).error).toMatchObject({
          code: "resource_constraint",
          details: {
            reported_limits: { boundary: "unlisted_keys", maximum: 1024 },
          },
        });
        continue;
      }
      for (const reply of [result.json, mcp.structuredContent]) {
        const report =
          toolContract("inspect_apple_ips").outputSchema.parse(
            reply,
          ).normalized_result;
        const row =
          kind === "thread"
            ? report.threads[0]
            : kind === "frame"
              ? report.threads[0]?.frames[0]
              : report.images[0];
        expect(row).toMatchObject({ unlisted_keys: keys });
        expect(report.coverage.status).toBe("complete");
      }
    }
  },
);

cliTest.for(["thread", "frame", "image"] as const)(
  "rejects duplicate unknown IPS %s keys through CLI and stdio MCP",
  async (kind, { cli }) => {
    const root = await createTestTempDirectory("rea-ips-duplicate-key-");
    const path = join(root, "report.ips");
    const duplicate = '"extra":null,"\\u0065xtra":false,';
    await writeFile(
      path,
      reportText(
        kind === "thread" ? duplicate : "",
        kind === "frame" ? duplicate : "",
        kind === "image" ? duplicate : "",
      ),
    );
    const result = await cli.run({
      arguments: ["inspect-apple-ips", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(JSON.stringify(result.json)).toContain("Duplicate JSON object key");
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected stdio MCP session");
    const mcp = await call("inspect_apple_ips", { path });
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(parseMcpToolError(mcp))).toContain(
      "Duplicate JSON object key",
    );
  },
);
