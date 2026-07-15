const [mode, value = "0"] = process.argv.slice(2);

const keepAlive = () => {
  setInterval(() => undefined, 1_000);
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
  default:
    process.stderr.write(`unknown provider-process fixture mode: ${mode}\n`);
    process.exitCode = 64;
}
