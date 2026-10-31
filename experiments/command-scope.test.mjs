import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { withCommands } from "./command-scope.mjs";

test("retains bounded producer diagnostics and a nonzero process outcome", async () => {
  await assert.rejects(
    withCommands((run) =>
      run(process.execPath, [
        "-e",
        "process.stderr.write('fixture refusal');process.exit(9)",
      ]),
    ),
    (error) => {
      assert.equal(error.reason, "process");
      assert.equal(error.snapshot.exitCode, 9);
      assert.equal(error.snapshot.stderr.text, "fixture refusal");
      return true;
    },
  );
});
test("refuses incomplete output instead of accepting a truncated result", async () => {
  await assert.rejects(
    withCommands((run) =>
      run(process.execPath, ["-e", "process.stdout.write('x'.repeat(8192))"], {
        maxBytes: 1024,
      }),
    ),
    (error) => error.reason === "output-limit",
  );
});
test("propagates SIGINT as cancellation without forced termination", async () => {
  const module = new URL("./command-scope.mjs", import.meta.url).href;
  const code = `import {withCommands} from ${JSON.stringify(module)};
try { await withCommands(async run => { process.stdout.write('ready\\n'); await run(process.execPath,['-e','setInterval(()=>{},1000)']); }); }
catch (error) { process.stdout.write(error.reason+'\\n'); process.exitCode=error.reason==='cancelled'?0:1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  let signalled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!signalled && output.includes("ready")) {
      signalled = true;
      child.kill("SIGINT");
    }
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [exit] = await once(child, "close");
    assert.equal(exit, 0, output + diagnostic);
    assert.match(output, /cancelled/u);
  } finally {
    clearTimeout(timeout);
  }
});
