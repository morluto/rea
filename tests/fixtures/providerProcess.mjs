import { spawn } from "node:child_process";

const [mode, value = "0"] = process.argv.slice(2);
let keepAliveTimer;
let detachedChild;

const keepAlive = () => {
  keepAliveTimer = setInterval(() => undefined, 1_000);
};

const stopDetachedFixture = (signal) => {
  if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
  if (detachedChild?.exitCode === null) detachedChild.kill(signal);
  process.exitCode = signal === "SIGINT" ? 130 : 143;
};

const write = (stream, data) =>
  new Promise((resolve, reject) => {
    stream.write(data, (cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });

switch (mode) {
  case "burst": {
    const bytes = Number(value);
    await Promise.all([
      write(process.stdout, "o".repeat(bytes)),
      write(process.stderr, "e".repeat(bytes)),
    ]);
    process.exitCode = 23;
    break;
  }
  case "exit":
    process.exitCode = Number(value);
    break;
  case "graceful":
    process.on("SIGTERM", () => process.exit(0));
    await write(process.stdout, "ready\n");
    keepAlive();
    break;
  case "stubborn":
    process.on("SIGTERM", () => undefined);
    await write(process.stdout, "ready\n");
    keepAlive();
    break;
  case "detached-child": {
    detachedChild = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => undefined, 1000); setTimeout(() => process.exit(0), 10000)",
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      detachedChild.once("spawn", resolve);
      detachedChild.once("error", reject);
    });
    process.once("SIGINT", () => stopDetachedFixture("SIGINT"));
    process.once("SIGTERM", () => stopDetachedFixture("SIGTERM"));
    await write(process.stdout, `ready:${detachedChild.pid}\n`);
    detachedChild.unref();
    keepAlive();
    break;
  }
  default:
    process.stderr.write(`unknown provider-process fixture mode: ${mode}\n`);
    process.exitCode = 64;
}
