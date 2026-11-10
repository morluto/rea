import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { readerViewsOfBytes } from "../../../src/application/desktop/DesktopTaskReaders.js";
import { runReaderHere } from "../../../src/desktop/TaskReaderProcess.js";

import {
  readerAnswerView,
  readerCommand,
  PYTHON_READER_CLEANUP,
} from "../../../src/domain/desktop/appTaskReaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const reader = {
  id: "scratch",
  file: "Documents/document.bin",
  argv: [
    "python3",
    "-c",
    String.raw`import json, os, sys, tempfile
data = open(sys.argv[1], "rb").read()
fd, path = tempfile.mkstemp(prefix="headless-scratch-")
with os.fdopen(fd, "wb") as scratch:
    scratch.write(data)
print("REA " + json.dumps({"copy": sys.argv[1], "scratch": path,
                          "temporary": {k: os.environ.get(k) for k in ("TMPDIR", "TMP", "TEMP")}}))`,
    "{file}",
  ],
  output: "json" as const,
};

interface ScratchReport {
  readonly copy: string;
  readonly scratch: string;
  readonly temporary: Record<string, string>;
}

const fixture = async () => {
  const root = await createTestTempDirectory("reader-scratch-");
  const source = join(root, "document.bin");
  const inherited = join(root, "session-temp");
  const work = join(root, "work");
  await writeFile(source, "original document");
  await mkdir(inherited);
  await mkdir(work);
  const env = {
    ...process.env,
    TMPDIR: inherited,
    TMP: inherited,
    TEMP: inherited,
  };
  return { source, inherited, work, env };
};

const reportOf = (stdout: string): ScratchReport => {
  const answer = readerAnswerView(stdout);
  expect(answer?.format).toBe("json");
  return answer?.view as unknown as ScratchReport;
};

const expectOwnedTemporary = (report: ScratchReport, owned: string) => {
  const temporary = join(owned, "t");
  expect(dirname(report.scratch)).toBe(temporary);
  expect(report.temporary).toEqual({
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  });
};

const IPC_READER = String.raw`import json, os, sys, threading
from multiprocessing.connection import Client, Listener
data = open(sys.argv[1], "rb").read()
with Listener() as listener:
    address = listener.address
    def send():
        with Client(address) as peer:
            peer.send_bytes(data)
    sender = threading.Thread(target=send)
    sender.start()
    with listener.accept() as peer:
        received = peer.recv_bytes()
    sender.join()
print("REA " + json.dumps({"received": received.decode(), "socket": address,
                          "copy": sys.argv[1], "temporary": os.environ["TMPDIR"]}))`;

it.skipIf(process.platform === "win32")(
  "keeps Unix sockets usable in the nested local-export scratch layout",
  async () => {
    vi.stubEnv("TMPDIR", "/tmp");
    try {
      const root = await createTestTempDirectory("ipc-");
      const length = process.platform === "darwin" ? 49 : 52;
      const inherited = join(
        root,
        "x".repeat(length - Buffer.byteLength(root) - 1),
      );
      expect(Buffer.byteLength(inherited)).toBe(length);
      await mkdir(inherited);
      for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, inherited);
      const source = join(root, "document.bin");
      await writeFile(source, "original document");
      const control = await execute("python3", ["-c", IPC_READER, source]);
      const controlReport: unknown = JSON.parse(
        control.stdout.slice("REA ".length),
      );
      expect(controlReport).toMatchObject({
        received: "original document",
      });
      const views = await readerViewsOfBytes(
        [
          {
            ...reader,
            id: "ipc",
            argv: ["python3", "-c", IPC_READER, "{file}"],
          },
        ],
        async () => ({
          kind: "bytes",
          bytes: Buffer.from("original document"),
        }),
        (argv, timeoutS) => runReaderHere(argv, timeoutS),
      );
      expect(views.get("ipc")?.error).toBeUndefined();
      expect(views.get("ipc")).toMatchObject({
        format: "json",
        view: { received: "original document" },
      });
      const view = views.get("ipc")?.view as unknown as {
        readonly copy: string;
        readonly socket: string;
        readonly temporary: string;
      };
      const owned = dirname(dirname(view.copy));
      expect(view.temporary).toBe(join(owned, "t"));
      expect(view.socket.startsWith(`${view.temporary}/`)).toBe(true);
      expect(Buffer.byteLength(view.socket)).toBeLessThan(
        process.platform === "darwin" ? 104 : 108,
      );
      await expect(access(owned)).rejects.toThrow();
      await expect(access(view.socket)).rejects.toThrow();
      expect(await readdir(inherited)).toEqual([]);
      expect(await readFile(source, "utf8")).toBe("original document");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "retains ordinary scratch files in the remote lease until its matching cleanup",
  async () => {
    const { source, inherited, work, env } = await fixture();
    const lease = { path: join(work, "owned"), token: "scratch-owner" };
    const [python = "", ...argv] = readerCommand(
      reader,
      source,
      undefined,
      lease,
    );
    const { stdout } = await execute(python, argv, { env });
    const report = reportOf(stdout);
    try {
      expectOwnedTemporary(report, lease.path);
      expect(await readFile(report.scratch, "utf8")).toBe("original document");
      expect(await readdir(inherited)).toEqual([]);
      expect(await readFile(source, "utf8")).toBe("original document");
    } finally {
      await execute(python, [
        "-I",
        "-c",
        PYTHON_READER_CLEANUP,
        JSON.stringify(lease),
      ]);
    }
    await expect(access(report.scratch)).rejects.toThrow();
    await expect(access(lease.path)).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "removes normal local scratch files with the reader folder after success",
  async () => {
    const { source, inherited, work, env } = await fixture();
    const [python = "", ...argv] = readerCommand(reader, source, work);
    const { stdout } = await execute(python, argv, { env });
    const report = reportOf(stdout);
    const owned = dirname(dirname(report.copy));
    expectOwnedTemporary(report, owned);
    await expect(access(report.scratch)).rejects.toThrow();
    await expect(access(owned)).rejects.toThrow();
    expect(await readdir(inherited)).toEqual([]);
    expect(await readFile(source, "utf8")).toBe("original document");
  },
);
