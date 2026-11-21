import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";

const exec = promisify(execFile);

/** Exercise the OpenJDK Unix-socket boundary through real Ghidra and REA. */
export async function verifyGhidraSocketBoundary({
  target,
  procedure,
  entrypoint,
  env,
}) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return {
      status: "not-applicable",
      reason: "The Ghidra Unix-socket lane is not used on this host.",
    };
  const limit = process.platform === "darwin" ? 102 : 106;
  const before = createHash("sha256")
    .update(await readFile(target.path))
    .digest("hex");
  const root = await realpath(await mkdtemp("/tmp/rea-gsock-"));
  const suffixBytes = Buffer.byteLength("/rea-ghidra-XXXXXX/bridge.sock");
  let cleanupIncomplete = false;
  const samples = [];
  try {
    for (const { proposedBytes, unicode } of [
      { proposedBytes: limit, unicode: false },
      { proposedBytes: limit + 1, unicode: false },
      { proposedBytes: limit + 2, unicode: false },
      { proposedBytes: limit + 1, unicode: true },
    ]) {
      const character = unicode ? "雪" : "";
      const padding =
        proposedBytes -
        suffixBytes -
        Buffer.byteLength(root) -
        1 -
        Buffer.byteLength(character);
      assert.ok(
        padding > 0,
        "Verifier workspace leaves no room for the boundary fixture",
      );
      const parent = join(root, "x".repeat(padding) + character);
      await mkdir(parent);
      assert.equal(Buffer.byteLength(parent) + suffixBytes, proposedBytes);
      if (unicode) assert.ok(Buffer.byteLength(parent) > parent.length);
      const sessionEnv = { ...env, TMPDIR: parent };
      const client = new Client({
        name: "rea-ghidra-socket-boundary",
        version: "1",
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint, "mcp"],
        env: sessionEnv,
        stderr: "pipe",
      });
      let connected = false;
      let opened = false;
      let runtimeRoot;
      let socketRoot;
      let endpoint;
      const cleanup = async (task) => {
        try {
          await task();
        } catch (cause) {
          cleanupIncomplete = true;
          throw cause;
        }
      };
      await withVerifierCleanup(async () => {
        await client.connect(transport);
        connected = true;
        const tools = new Map(
          (await client.listTools()).tools.map((tool) => [tool.name, tool]),
        );
        const call = async (name, arguments_ = {}) => {
          const reply = await client.callTool(
            { name, arguments: arguments_ },
            { timeout: 180000, toolDefinition: tools.get(name) },
          );
          assert.notEqual(
            reply.isError,
            true,
            `${name}: ${JSON.stringify(reply)}`,
          );
          return reply.structuredContent ?? JSON.parse(reply.content[0].text);
        };
        await call("open_binary", { path: target.path, provider_id: "ghidra" });
        opened = true;
        await call("list_documents");
        const roots = (await readdir(parent)).filter((name) =>
          name.startsWith("rea-ghidra-"),
        );
        assert.equal(roots.length, 1);
        runtimeRoot = join(parent, roots[0]);
        endpoint = JSON.parse(
          await readFile(join(runtimeRoot, "ownership.json"), "utf8"),
        ).endpoint_path;
        assert.equal(
          Buffer.byteLength(join(runtimeRoot, "bridge.sock")),
          proposedBytes,
        );
        const fallback = dirname(endpoint) !== runtimeRoot;
        assert.equal(fallback, proposedBytes > limit);
        if (fallback) {
          socketRoot = dirname(endpoint);
          assert.match(basename(socketRoot), /^rea-ghidra-socket-/u);
          assert.equal((await stat(socketRoot)).mode & 0o777, 0o700);
        }
        samples.push({
          proposed_bytes: proposedBytes,
          unicode,
          endpoint_bytes: Buffer.byteLength(endpoint),
          fallback,
        });
      }, [
        () =>
          cleanup(async () => {
            if (!connected || !opened) return;
            const reply = await client.callTool(
              { name: "close_binary", arguments: {} },
              { timeout: 180000 },
            );
            assert.notEqual(
              reply.isError,
              true,
              `close_binary: ${JSON.stringify(reply)}`,
            );
          }),
        () =>
          cleanup(async () => {
            await client.close();
          }),
        () =>
          cleanup(async () => {
            await transport.close();
          }),
      ]);
      await assert.rejects(access(runtimeRoot), { code: "ENOENT" });
      if (socketRoot !== undefined)
        await assert.rejects(access(socketRoot), { code: "ENOENT" });
      if (proposedBytes === limit + 1 && !unicode) {
        const { stdout } = await exec(
          process.execPath,
          [
            entrypoint,
            "function",
            target.path,
            procedure,
            "--provider",
            "ghidra",
            "--json",
          ],
          { env: sessionEnv, timeout: 240000, maxBuffer: 72 * 1024 * 1024 },
        );
        assert.ok(JSON.parse(stdout).normalized_result.procedure);
        assert.deepEqual(
          (await readdir(parent)).filter((name) =>
            name.startsWith("rea-ghidra-"),
          ),
          [],
          "CLI left a Ghidra runtime directory",
        );
      }
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(target.path))
        .digest("hex"),
      before,
    );
    return {
      status: "verified",
      samples,
      cli_boundary: true,
      target_unchanged: true,
    };
  } finally {
    // A failed cleanup retains its exact workspace for investigation and retry.
    if (!cleanupIncomplete) await rm(root, { recursive: true, force: true });
  }
}
