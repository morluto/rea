import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withCommands } from "../command-scope.mjs";

const script = fileURLToPath(new URL("./verify.mjs", import.meta.url));
test("persists an admitted preflight failure before any producer starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-aapt2-preflight-"));
  const output = join(root, "result");
  const framework = join(root, "missing-framework.jar");
  try {
    await assert.rejects(
      withCommands((run) =>
        run(process.execPath, [
          script,
          "--aapt2",
          join(root, "missing-aapt2"),
          "--apktool",
          join(root, "missing-apktool"),
          "--framework",
          framework,
          "--output",
          output,
        ]),
      ),
    );
    const receipt = JSON.parse(
      await readFile(join(output, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.outcome, "failed");
    assert.deepEqual(receipt.commands, []);
    assert.equal(receipt.framework.path, framework);
    assert.match(JSON.stringify(receipt.failure), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an occupied output directory without overwriting its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-aapt2-collision-"));
  const marker = join(root, "preserve.txt");
  await writeFile(marker, "caller evidence");
  try {
    await assert.rejects(
      withCommands((run) =>
        run(process.execPath, [
          script,
          "--aapt2",
          "missing-aapt2",
          "--apktool",
          "missing-apktool",
          "--framework",
          "missing.jar",
          "--output",
          root,
        ]),
      ),
      (error) =>
        error.reason === "process" &&
        error.snapshot.stderr.text.includes("EEXIST"),
    );
    assert.equal(await readFile(marker, "utf8"), "caller evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
for (const mode of ["exit", "truncation"])
  test(
    `persists earlier commands and ${mode} diagnostics in a failed verifier receipt`,
    {
      skip:
        process.platform === "win32"
          ? "The selected executable fixture uses a POSIX shebang"
          : false,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-aapt2-failure-"));
      const binary = join(root, "producer");
      const framework = join(root, "framework.jar");
      const output = join(root, "result");
      await writeFile(
        framework,
        "fixture input: compilation fails before linking",
      );
      await writeFile(
        binary,
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'version') ${mode === "exit" ? "console.error('Android Asset Packaging Tool (aapt) 2.19-fixture');" : "console.log('fixture AAPT2');"}
else if (args.length === 1 && args[0] === '--version') console.log('${mode === "exit" ? "2.7.0-dirty" : "3.0.3"}');
else if (args.length === 5 && args[0] === 'compile' && args[1] === '--dir' && args[3] === '-o') {
  ${mode === "exit" ? "process.stdout.write('partial compile output'); process.stderr.write('fixture compile refused'); process.exitCode = 9;" : "process.stdout.write('x'.repeat(5 * 1024 * 1024));"}
} else { console.error('unmodeled command', args); process.exitCode = 97; }
`,
        { mode: 0o700 },
      );
      try {
        let terminalFailure;
        await assert.rejects(
          withCommands((run) =>
            run(
              process.execPath,
              [
                script,
                "--aapt2",
                binary,
                "--apktool",
                binary,
                "--framework",
                framework,
                "--output",
                output,
              ],
              { maxBytes: 1024 * 1024 },
            ),
          ),
          (error) => {
            assert.equal(error.reason, "process");
            assert.equal(error.snapshot.exitCode, 1);
            terminalFailure = JSON.parse(error.snapshot.stderr.text);
            return true;
          },
        );
        const receipt = JSON.parse(
          await readFile(join(output, "receipt.json"), "utf8"),
        );
        assert.equal(receipt.outcome, "failed");
        assert.equal(receipt.commands.length, 3);
        assert.equal(receipt.commands[0].outcome, "completed");
        assert.equal(
          receipt.commands[0].stdout,
          mode === "exit" ? "" : "fixture AAPT2\n",
        );
        assert.equal(receipt.version, mode === "exit" ? "2.19-fixture" : null);
        assert.deepEqual(
          receipt.version_observations,
          mode === "exit"
            ? [{ channel: "stderr", version: "2.19-fixture" }]
            : [],
        );
        assert.equal(
          receipt.commands[1].stdout,
          mode === "exit" ? "2.7.0-dirty\n" : "3.0.3\n",
        );
        assert.equal(receipt.apktool_build_family, mode === "exit" ? 2 : 3);
        assert.equal(terminalFailure.outcome, "failed");
        assert.equal(
          terminalFailure.receipt_path,
          join(output, "receipt.json"),
        );
        assert.equal(terminalFailure.receipt_published, true);
        assert.equal(terminalFailure.failure.reason, receipt.failure.reason);
        assert.equal("stdout" in terminalFailure.failure.snapshot, false);
        if (mode === "exit")
          assert.equal(terminalFailure.failure.snapshot.exitCode, 9);
        const failed = receipt.commands[2];
        assert.equal(failed.binary, binary);
        assert.equal(failed.arguments[0], "compile");
        assert.equal(failed.outcome, "failed");
        for (const record of [failed.error, receipt.failure]) {
          assert.equal(
            record.reason,
            mode === "exit" ? "process" : "output-limit",
          );
          assert(
            record.snapshot,
            "Owner-captured command diagnostics must survive the receipt",
          );
          assert.equal(record.cleanup_failure, null);
          assert.deepEqual(record.resources, []);
          assert.equal(record.collection_failure, false);
          if (mode === "exit") {
            assert.equal(record.snapshot.exitCode, 9);
            assert.equal(record.snapshot.signal, null);
            assert.equal(record.snapshot.stdout.text, "partial compile output");
            assert.equal(
              record.snapshot.stderr.text,
              "fixture compile refused",
            );
            assert.equal(
              record.snapshot.stderr.bytes,
              Buffer.byteLength("fixture compile refused"),
            );
          } else {
            assert.equal(record.snapshot.diagnosticTruncated, true);
            assert(record.snapshot.stdout.bytes > 0);
            assert(
              record.snapshot.stdout.bytes + record.snapshot.stderr.bytes <=
                4 * 1024 * 1024,
            );
            assert(
              record.snapshot.stdout.observedBytes >
                record.snapshot.stdout.bytes,
            );
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
test(
  "reports primary and receipt-publication failures without expanded diagnostics",
  {
    skip:
      process.platform === "win32"
        ? "The producer fixture uses a POSIX shebang"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-publication-"));
    const binary = join(root, "producer");
    const framework = join(root, "framework.jar");
    const output = join(root, "result");
    await writeFile(
      framework,
      "fixture: publication fails after a producer refusal",
    );
    await writeFile(
      binary,
      `#!${process.execPath}
import {mkdirSync} from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'version') console.error('Android Asset Packaging Tool (aapt) 2.19-fixture');
else if (args[0] === '--version') console.log('3.0.3');
else if (args[0] === 'compile') {
  mkdirSync(${JSON.stringify(join(output, "receipt.json"))});
  console.error('controlled compile refusal'); process.exitCode = 9;
} else process.exitCode = 97;
`,
      { mode: 0o700 },
    );
    try {
      await assert.rejects(
        withCommands((run) =>
          run(process.execPath, [
            script,
            "--aapt2",
            binary,
            "--apktool",
            binary,
            "--framework",
            framework,
            "--output",
            output,
          ]),
        ),
        (error) => {
          assert.equal(error.reason, "process");
          assert.equal(error.snapshot.exitCode, 1);
          const failure = JSON.parse(error.snapshot.stderr.text);
          assert.equal(failure.receipt_published, false);
          assert.equal(failure.receipt_path, join(output, "receipt.json"));
          assert.equal(failure.failure.name, "AggregateError");
          assert.equal(failure.failure.errors[0].reason, "process");
          assert.equal(failure.failure.errors[0].snapshot.exitCode, 9);
          assert.equal("stdout" in failure.failure.errors[0].snapshot, false);
          assert.equal(failure.failure.errors[1].code, "EISDIR");
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "refuses unknown or unsupported Apktool build families before compiling",
  {
    skip:
      process.platform === "win32"
        ? "The probe fixture uses a POSIX shebang"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-version-"));
    const binary = join(root, "producer");
    const framework = join(root, "framework.jar");
    await writeFile(
      framework,
      "fixture: version admission precedes compilation",
    );
    try {
      for (const [index, version] of [
        "fixture Apktool",
        "2.6.1",
        "4.0.0",
      ].entries()) {
        await writeFile(
          binary,
          `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'version') console.error('Android Asset Packaging Tool (aapt) 2.19-fixture');
else if (args[0] === '--version') console.log(${JSON.stringify(version)});
else { console.error('unexpected compilation'); process.exitCode = 97; }
`,
          { mode: 0o700 },
        );
        const output = join(root, `result-${index}`);
        await assert.rejects(
          withCommands((run) =>
            run(process.execPath, [
              script,
              "--aapt2",
              binary,
              "--apktool",
              binary,
              "--framework",
              framework,
              "--output",
              output,
            ]),
          ),
        );
        const receipt = JSON.parse(
          await readFile(join(output, "receipt.json"), "utf8"),
        );
        assert.equal(receipt.outcome, "failed");
        assert.equal(receipt.apktool_build_family, null);
        assert.equal(receipt.commands.length, 2);
        assert.match(
          receipt.failure.message,
          /no build protocol was selected/u,
        );
        assert.equal(
          receipt.apktool_identity.version ??
            receipt.apktool_identity.reportedVersion,
          version,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
const framework = process.env.REA_AAPT2_PROBE_FRAMEWORK;
const aapt2 = process.env.REA_AAPT2_PROBE_COMMAND;
const apktool = process.env.REA_APKTOOL_COMMAND;
test(
  "real AAPT2 inspection, compile/link and Apktool rebuild preserve input identity",
  {
    skip:
      framework === undefined || aapt2 === undefined || apktool === undefined
        ? "Set REA_AAPT2_PROBE_FRAMEWORK, REA_AAPT2_PROBE_COMMAND and REA_APKTOOL_COMMAND for the real lane"
        : false,
    timeout: 300_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-aapt2-real-"));
    try {
      const output = join(root, "result");
      const result = await withCommands((run) =>
        run(
          process.execPath,
          [
            script,
            "--aapt2",
            aapt2,
            "--apktool",
            apktool,
            "--framework",
            framework,
            "--output",
            output,
          ],
          { timeoutMs: 240_000 },
        ),
      );
      assert.match(result.stdout, /prototype:.*passed/u);
      const receipt = JSON.parse(
        await readFile(join(output, "receipt.json"), "utf8"),
      );
      assert.equal(receipt.existing_decode_cli_mcp_parity, true);
      assert.equal(receipt.malformed_resource_refused, true);
      assert.equal(receipt.missing_framework_refused, true);
      assert.equal(receipt.outcome, "completed");
      const build = receipt.commands.find(
        (command) => command.arguments[0] === "b",
      );
      assert.equal(
        build.arguments.includes("--use-aapt2"),
        receipt.apktool_build_family === 2,
      );
      assert.equal(
        build.arguments[build.arguments.indexOf("--aapt") + 1],
        aapt2,
      );
      assert.match(receipt.rebuilt.sha256, /^[a-f0-9]{64}$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
