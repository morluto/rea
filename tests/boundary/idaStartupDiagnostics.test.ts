import { describe, expect, it } from "vitest";
import { createIdaMcpConnection } from "../../src/ida/IdaMcpConnection.js";

describe("IDA startup diagnostics", () => {
  it("preserves the failing launcher's stderr instead of reporting only a closed transport", async () => {
    const connection = createIdaMcpConnection(
      {
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("FATAL: IDA runtime initialization failed\\n", () => process.exit(2));',
        ],
        env: {},
        mode: "headless",
        timeoutMs: 1000,
      },
      {},
    );
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        _tag: "ProviderAdapterError",
        capturedOutput: {
          stderr: expect.stringContaining("IDA runtime initialization failed"),
          truncated: false,
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("retains only the bounded stderr tail and reports the original byte count", async () => {
    const connection = createIdaMcpConnection(
      {
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("x".repeat(20000) + "FATAL-END", () => process.exit(2));',
        ],
        env: {},
        mode: "headless",
        timeoutMs: 1000,
      },
      {},
    );
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        _tag: "ProviderAdapterError",
        capturedOutput: {
          stderr: "x".repeat(16384 - "FATAL-END".length) + "FATAL-END",
          stderr_bytes: 20000 + "FATAL-END".length,
          truncated: true,
        },
      });
    } finally {
      await connection.close();
    }
  });
});

it("drops a leading partial UTF-8 character from the bounded stderr tail", async () => {
  const connection = createIdaMcpConnection(
    {
      command: process.execPath,
      args: [
        "-e",
        'process.stderr.write("€".repeat(6000), () => process.exit(2));',
      ],
      env: {},
      mode: "headless",
      timeoutMs: 1000,
    },
    {},
  );
  try {
    await expect(connection.connect()).rejects.toMatchObject({
      capturedOutput: {
        stderr: "€".repeat(Math.floor(16384 / 3)),
        stderr_bytes: 18000,
        truncated: true,
      },
    });
  } finally {
    await connection.close();
  }
});

it("retains an in-budget undecodable leading byte without claiming tail truncation", async () => {
  const connection = createIdaMcpConnection(
    {
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write(Buffer.from([0x80, 0x61, 0x62]), () => process.exit(2));",
      ],
      env: {},
      mode: "headless",
      timeoutMs: 1000,
    },
    {},
  );
  try {
    const failure = await connection.connect().catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      capturedOutput: { stderr: "�ab", stderr_bytes: 3, truncated: false },
    });
    expect(failure).not.toHaveProperty("diagnostics.upstream_stderr");
  } finally {
    await connection.close();
  }
});
