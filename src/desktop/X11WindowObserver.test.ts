import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { X11WindowObserver } from "./X11WindowObserver.js";

it.skipIf(process.platform === "win32").each([false, true])(
  "observes an inert command's client list or exact cancellation (cancelled: %s)",
  async (cancelled) => {
    const root = await createTestTempDirectory("xprop-inert-");
    const command = join(root, "xprop");
    await writeFile(
      command,
      `#!${process.execPath}\nprocess.stdout.write("_NET_CLIENT_LIST: window id # \\n");\n`,
    );
    await chmod(command, 0o700);
    const reason = new Error("caller cancelled window observation");
    const observer = new X11WindowObserver(command, {});
    const result = await observer
      .sample(() => false, cancelled ? AbortSignal.abort(reason) : undefined)
      .catch((cause: unknown) => cause);
    if (!cancelled) expect(result).toEqual({ state: "listed", windows: [] });
    else {
      expect(result).toBeInstanceOf(ArtifactReaderFailure);
      expect(result).toMatchObject({ reason: "cancelled", cause: reason });
      if (!(result instanceof ArtifactReaderFailure))
        throw new Error("expected actual command cancellation");
      expect(result.cause).toBe(reason);
    }
  },
);
