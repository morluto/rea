import { describe, expect, it } from "vitest";
import { createIdaMcpConnection } from "../../src/ida/IdaMcpConnection.js";
import { idaConnectionDependencies } from "../support/idaConnectionDependencies.js";

const launcherEnvironment = (): Readonly<Record<string, string>> => {
  if (process.platform !== "win32") return {};
  const systemRoot = process.env.SYSTEMROOT;
  if (systemRoot === undefined || systemRoot.length === 0)
    throw new Error("The Windows Node fixture requires its actual SYSTEMROOT.");
  return { SYSTEMROOT: systemRoot };
};

const failureText = "FATAL: IDA runtime initialization failed\n";
const tailMarker = "FATAL-END";

describe("IDA startup diagnostics", () => {
  it.each([
    {
      label: "keeps undecodable bytes when the launcher stderr fits",
      write: `Buffer.concat([Buffer.from([0x80]), Buffer.from(${JSON.stringify(failureText)})])`,
      stderr: "\ufffd" + failureText,
      bytes: 1 + Buffer.byteLength(failureText),
      truncated: false,
    },
    {
      label: "preserves the bounded tail and removes its partial UTF-8 prefix",
      write: `"discarded\\n" + "€".repeat(6000) + ${JSON.stringify(tailMarker)}`,
      stderr:
        "€".repeat(Math.floor((16384 - tailMarker.length) / 3)) + tailMarker,
      bytes: "discarded\n".length + 6000 * 3 + tailMarker.length,
      truncated: true,
    },
  ])("$label", async ({ write, stderr, bytes, truncated }) => {
    const connection = createIdaMcpConnection(
      {
        command: process.execPath,
        args: ["-e", `process.stderr.write(${write}, () => process.exit(2));`],
        env: launcherEnvironment(),
        mode: "headless",
        protocol: "modern",
        timeoutMs: 1000,
      },
      {},
      idaConnectionDependencies(),
    );
    try {
      const failure = await connection
        .connect()
        .catch((cause: unknown) => cause);
      expect(failure).toMatchObject({
        _tag: "ProviderAdapterError",
        capturedOutput: { stderr, stderr_bytes: bytes, truncated },
      });
      expect(failure).not.toHaveProperty("diagnostics.upstream_stderr");
    } finally {
      await connection.close();
    }
  });
});
