import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Real unusable Java runtimes and selectors must lead to applicable recovery. */
export async function verifyAndroidFailureRecovery({
  java,
  entrypoint,
  environment,
  path,
  repository,
  execute,
  fixture,
}) {
  const root = await mkdtemp(join(tmpdir(), "rea-android-recovery-"));
  try {
    let jlink;
    for (const candidate of isAbsolute(java)
      ? [join(dirname(java), "jlink")]
      : (environment.PATH ?? "")
          .split(delimiter)
          .map((directory) => join(directory, "jlink"))) {
      try {
        await access(candidate);
        jlink = candidate;
        break;
      } catch (cause) {
        if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") throw cause;
      }
    }
    if (jlink === undefined)
      throw new Error(
        "Android failure-recovery verification requires the full JDK's jlink via JAVA_HOME or PATH.",
      );
    const jre = join(root, "jre");
    await execute(jlink, ["--add-modules", "java.base", "--output", jre], {
      timeout: 60_000,
    });
    await execute(join(jre, "bin/java"), ["-version"], { timeout: 10_000 });
    const empty = join(root, "empty-path");
    await mkdir(empty);
    if (process.platform === "linux") {
      // Keep the real ownership prerequisite available while removing Java.
      const { stdout } = await execute("/bin/sh", ["-c", "command -v ps"], {
        env: environment,
        timeout: 10_000,
      });
      const ps = stdout.trim();
      assert.ok(
        isAbsolute(ps),
        "Linux recovery verification requires procps ps",
      );
      await symlink(ps, join(empty, "ps"));
    }
    const withoutJavaHome = { ...environment };
    delete withoutJavaHome.JAVA_HOME;
    const environments = [
      {
        label: "JRE without compiler",
        env: { ...environment, JAVA_HOME: jre },
        observation: "jdk.compiler",
      },
      {
        label: "missing java",
        env: { ...withoutJavaHome, PATH: empty },
        observation: "ENOENT",
      },
    ];
    if (process.platform === "darwin") {
      // /usr/bin/java either resolves an installed runtime or reports the actual stub failure.
      try {
        await execute("/usr/bin/java", ["-version"], { timeout: 10_000 });
      } catch {
        environments.push({
          label: "macOS Java stub",
          env: { ...withoutJavaHome, PATH: "/usr/bin:/bin" },
          observation: "Unable to locate a Java Runtime",
        });
      }
    }
    for (const scenario of environments) {
      let failure;
      try {
        await execute(
          process.execPath,
          [entrypoint, "inspect-android-package", path, "--json"],
          {
            cwd: repository,
            env: scenario.env,
            timeout: 45_000,
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        assert.fail(`${scenario.label} unexpectedly succeeded`);
      } catch (cause) {
        assert.equal(cause.code, 1);
        failure = JSON.parse(cause.stdout);
      }
      assert.equal(failure.code, "capability_unavailable");
      assert.ok(
        JSON.stringify(failure).includes(scenario.observation),
        JSON.stringify(failure),
      );
      assert.match(failure.message, /full JDK/u);
      assert.match(failure.remediation.action, /java --list-modules/u);
      assert.doesNotMatch(JSON.stringify(failure), /rea doctor/u);
      console.log(`PASS CLI applicable recovery: ${scenario.label}`);
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      cwd: repository,
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({
      name: "rea-real-android-failures",
      version: "1",
    });
    try {
      await client.connect(transport);
      for (const name of [
        "inspect_android_class",
        "inspect_android_method",
        "trace_android_references",
      ]) {
        const response = await client.callTool(
          {
            name,
            arguments: {
              path,
              class_name: "no.such.Class",
              ...(name === "inspect_android_method"
                ? { method_name: "missing" }
                : {}),
            },
          },
          { timeout: 150_000 },
        );
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent.error.code, "invalid_request");
        assert.deepEqual(
          response.structuredContent.error.details.issues[0].path,
          ["class_name"],
        );
        assert.match(
          response.structuredContent.error.details.issues[0].message,
          /search_android_classes/u,
        );
        assert.doesNotMatch(JSON.stringify(response), /rea doctor/u);
        console.log(`PASS MCP selector correction: ${name}`);
      }
      const method = await client.callTool(
        {
          name: "inspect_android_method",
          arguments: {
            path,
            class_name: fixture.class_name,
            method_name: "noSuchMethod",
          },
        },
        { timeout: 150_000 },
      );
      assert.equal(method.structuredContent.error.code, "invalid_request");
      assert.deepEqual(method.structuredContent.error.details.issues[0].path, [
        "method_name",
      ]);
      await client.ping();
      const control = await client.callTool(
        { name: "inspect_android_package", arguments: { path } },
        { timeout: 150_000 },
      );
      assert.notEqual(control.isError, true, JSON.stringify(control));
      assert.equal(
        control.structuredContent.result.package_name,
        fixture.package,
      );
      console.log("PASS MCP valid package after selector failures");
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
