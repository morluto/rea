import { spawn } from "node:child_process";

/** Close the actual child handle and wait for its exit before releasing it. */
export const closeInferiorTty = async (helper) => {
  if (helper.exitCode !== null || helper.signalCode !== null) return;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const closed = () => {
        clearTimeout(timer);
        resolve();
      };
      helper.once("close", closed);
      timer = setTimeout(() => {
        helper.off("close", closed);
        reject(new Error("inferior TTY helper cleanup did not settle"));
      }, 1_000);
      helper.stdin?.end();
      helper.kill("SIGKILL");
    });
  } finally {
    clearTimeout(timer);
  }
};

/** Allocate a real terminal; failed readiness keeps ownership through cleanup. */
export const openInferiorTty = async (options = {}) => {
  const helper = spawn(
    options.command ?? "python3",
    options.arguments ?? [
      "-c",
      [
        "import os, pty, select, sys",
        "master, slave = pty.openpty()",
        "print(os.ttyname(slave), flush=True)",
        "while True:",
        "    ready, _, _ = select.select([master, sys.stdin], [], [], 1)",
        "    if sys.stdin in ready and not sys.stdin.readline():",
        "        break",
        "    if master in ready:",
        "        try: os.read(master, 65536)",
        "        except OSError: break",
      ].join("\n"),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  let timer;
  let onData;
  let onError;
  let onClose;
  try {
    const path = await new Promise((resolve, reject) => {
      let buffered = "";
      onData = (chunk) => {
        buffered += chunk.toString();
        const newline = buffered.indexOf("\n");
        if (newline >= 0) resolve(buffered.slice(0, newline).trim());
        else if (buffered.length > 4_096)
          reject(new Error("inferior TTY helper returned an oversized path"));
      };
      onError = reject;
      onClose = (code, signal) =>
        reject(
          new Error(
            `inferior TTY helper exited before readiness (${code}, ${signal})`,
          ),
        );
      helper.stdout.on("data", onData);
      helper.once("error", onError);
      helper.once("close", onClose);
      timer = setTimeout(
        () => reject(new Error("inferior TTY helper did not report a path")),
        options.timeoutMs ?? 10_000,
      );
    });
    return { helper, path };
  } catch (cause) {
    await closeInferiorTty(helper);
    throw cause;
  } finally {
    clearTimeout(timer);
    helper.stdout.off("data", onData);
    helper.off("error", onError);
    helper.off("close", onClose);
  }
};
