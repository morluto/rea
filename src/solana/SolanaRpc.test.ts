import { expect, it } from "vitest";
import {
  BPF_LOADER_UPGRADEABLE,
  decodeBase58,
  encodeBase58,
  fetchSolanaProgramElf,
  SolanaRpcFailure,
  SolanaRpcResponseTooLarge,
} from "./SolanaRpc.js";

const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

it("round-trips base58 public keys exactly", () => {
  for (const value of [
    PUMP_AMM,
    BPF_LOADER_UPGRADEABLE,
    "11111111111111111111111111111111",
  ]) {
    const decoded = decodeBase58(value);
    expect(decoded).toHaveLength(32);
    expect(encodeBase58(decoded as Uint8Array)).toBe(value);
  }
  expect(decodeBase58("0OIl")).toBeUndefined();
  expect(decodeBase58("")).toBeUndefined();
});

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const accountValue = (
  data: Uint8Array,
  owner: string,
  executable = true,
): unknown => ({
  data: [Buffer.from(data).toString("base64"), "base64"],
  owner,
  executable,
  lamports: 1,
  rentEpoch: 0,
});

it.each([1, 0])(
  "resolves an upgradeable program through its ProgramData account (authority tag %i)",
  async (authorityTag) => {
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const programDataAddress = decodeBase58(
      BPF_LOADER_UPGRADEABLE,
    ) as Uint8Array;
    const programAccount = new Uint8Array(36);
    new DataView(programAccount.buffer).setUint32(0, 2, true);
    programAccount.set(programDataAddress, 4);
    const programData = new Uint8Array(45 + elf.length);
    const dataView = new DataView(programData.buffer);
    dataView.setUint32(0, 3, true);
    dataView.setBigUint64(4, 4242n, true);
    // The ELF starts at byte 45 whether or not an upgrade authority is set.
    programData[12] = authorityTag;
    programData.set(elf, 45);
    const calls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as {
        params: readonly string[];
      };
      const address = body.params[0] as string;
      calls.push(address);
      return jsonResponse(
        address === PUMP_AMM
          ? accountValue(programAccount, BPF_LOADER_UPGRADEABLE)
          : accountValue(programData, BPF_LOADER_UPGRADEABLE, false),
      );
    }) as typeof fetch;
    const fetched = await fetchSolanaProgramElf(
      PUMP_AMM,
      "https://rpc.invalid",
      {
        fetchImpl,
      },
    );
    expect(calls).toEqual([PUMP_AMM, BPF_LOADER_UPGRADEABLE]);
    expect(fetched.programDataAccount).toBe(BPF_LOADER_UPGRADEABLE);
    expect(fetched.slot).toBe(4242);
    expect(Array.from(fetched.elfBytes)).toEqual(Array.from(elf));
  },
);

it("accepts a legacy-loader account holding the ELF directly", async () => {
  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  const fetchImpl = (async () =>
    jsonResponse(
      accountValue(elf, "BPFLoader2111111111111111111111111111111111"),
    )) as typeof fetch;
  const fetched = await fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", {
    fetchImpl,
  });
  expect(fetched.programDataAccount).toBeNull();
  expect(Array.from(fetched.elfBytes)).toEqual(Array.from(elf));
});

it("fails closed for missing accounts and malformed program ids", async () => {
  const fetchImpl = (async () => jsonResponse(null)) as unknown as typeof fetch;
  await expect(
    fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", { fetchImpl }),
  ).rejects.toThrow(SolanaRpcFailure);
  await expect(
    fetchSolanaProgramElf("not-a-key", "https://rpc.invalid", { fetchImpl }),
  ).rejects.toThrow(SolanaRpcFailure);
});

const ELF_PREFIX = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

it("refuses a non-executable data account even when it starts with ELF magic", async () => {
  const fetchImpl = (async () =>
    jsonResponse(
      accountValue(
        ELF_PREFIX,
        "BPFLoader2111111111111111111111111111111111",
        false,
      ),
    )) as typeof fetch;
  await expect(
    fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", { fetchImpl }),
  ).rejects.toThrow(/not executable/);
});

it("refuses an executable account whose owner is not an accepted loader", async () => {
  const fetchImpl = (async () =>
    jsonResponse(
      accountValue(ELF_PREFIX, "11111111111111111111111111111111"),
    )) as typeof fetch;
  await expect(
    fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", { fetchImpl }),
  ).rejects.toThrow(/only executable accounts/);
});

it("refuses ProgramData that the upgradeable loader does not own", async () => {
  const programAccount = new Uint8Array(36);
  new DataView(programAccount.buffer).setUint32(0, 2, true);
  programAccount.set(decodeBase58(BPF_LOADER_UPGRADEABLE) as Uint8Array, 4);
  const programData = new Uint8Array(13 + ELF_PREFIX.length);
  new DataView(programData.buffer).setUint32(0, 3, true);
  programData.set(ELF_PREFIX, 13);
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as {
      params: readonly string[];
    };
    return jsonResponse(
      body.params[0] === PUMP_AMM
        ? accountValue(programAccount, BPF_LOADER_UPGRADEABLE)
        : accountValue(programData, "11111111111111111111111111111111", false),
    );
  }) as typeof fetch;
  await expect(
    fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", { fetchImpl }),
  ).rejects.toThrow(/not BPF Loader Upgradeable/);
});

it("refuses oversized account data before decoding it", async () => {
  const fetchImpl = (async () =>
    jsonResponse(
      accountValue(
        new Uint8Array(4096),
        "BPFLoader2111111111111111111111111111111111",
      ),
    )) as typeof fetch;
  await expect(
    fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", {
      fetchImpl,
      maxProgramBytes: 64,
    }),
  ).rejects.toThrow(SolanaRpcResponseTooLarge);
});

it("stops reading a response body once it passes the allowance", async () => {
  let pulled = 0;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
          if (pulled > 1000) controller.close();
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  await expect(
    fetchSolanaProgramElf(PUMP_AMM, "https://rpc.invalid", {
      fetchImpl,
      maxProgramBytes: 64,
    }),
  ).rejects.toThrow(SolanaRpcResponseTooLarge);
  expect(pulled).toBeLessThan(10);
});

it("keeps endpoint credentials out of transport failure messages", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const failure = await fetchSolanaProgramElf(
    PUMP_AMM,
    "https://user:pass@rpc.invalid/token-path?api-key=secret",
    { fetchImpl },
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(SolanaRpcFailure);
  const message = (failure as Error).message;
  expect(message).toContain("https://rpc.invalid");
  expect(message).not.toMatch(/secret|token-path|user|pass/);
});
