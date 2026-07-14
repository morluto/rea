import { spawn } from "node:child_process";

const mode = process.argv[2];

if (mode === "interactive") {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write("prompt> ");
  process.on("SIGWINCH", () => {
    process.stdout.write(
      `resize:${String(process.stdout.columns)}x${String(process.stdout.rows)}\n`,
    );
  });
  process.on("SIGINT", () => {
    process.stdout.write("signal:SIGINT\n");
    process.exit(0);
  });
  process.stdin.on("data", (value) => {
    process.stdout.write(`input:${value.toString()} unicode:雪\n`);
  });
} else if (mode === "silent-interactive") {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (value) => {
    process.stdout.write(`input:${value.toString()}\n`);
    process.exit(0);
  });
} else if (mode === "partial") {
  process.stdout.write("partial-");
  setTimeout(() => {
    process.stdout.write("frame\n");
    process.exit(0);
  }, 25);
} else if (mode === "tree-child") {
  spawn(process.execPath, [process.argv[1], "tree-grandchild"], {
    stdio: "ignore",
  });
  setInterval(() => undefined, 1_000);
} else if (mode === "tree-grandchild") {
  setInterval(() => undefined, 1_000);
} else if (mode === "tree") {
  spawn(process.execPath, [process.argv[1], "tree-child"], { stdio: "ignore" });
  process.stdout.write("tree-ready\n");
  setInterval(() => undefined, 1_000);
} else if (mode === "crash") {
  process.stderr.write("intentional-crash\n");
  process.exit(23);
} else if (mode === "hang") {
  setInterval(() => undefined, 1_000);
} else {
  process.stderr.write("unknown fixture mode\n");
  process.exit(2);
}
