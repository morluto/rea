import { EVMOLE_VERSION } from "./EvmoleProviderIdentity.js";
import { EvmAdmissionError } from "./EvmAdmissionError.js";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  decodeEvmBytecodeCarrier,
  EvmCarrierFailure,
} from "./EvmBytecodeCarrier.js";
import { evmoleInterfaceReplySchema } from "./EvmoleInterfaceAdapter.js";
import { inspectSolidityMetadata } from "./SolidityMetadata.js";
import { EVM_FILE_SIZE_FAILURE_EXIT } from "./EvmoleRelease.js";
import {
  evmProducerLimitsSchema,
  selectedEvmProducerLimits,
} from "../domain/evm/evmInterface.js";
import { parseJsonWithDuplicatePolicy } from "../domain/jsonDuplicateMember.js";
import { readStableArtifact } from "../resources/index.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const requestSchema = z.strictObject({
  snapshot_path: z.string(),
  reply_path: z.string(),
  failure_marker_path: z.string(),
  encoding: z.enum(["raw", "hex"]),
  producer_limits: evmProducerLimitsSchema,
});
/** Maximum UTF-8 byte size of the REA-authored worker request JSON file. */
const MAX_EVM_WORKER_REQUEST_BYTES = 64 * 1024;
class UnsupportedContainer extends Error {}

const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined)
    throw new EvmAdmissionError("request_path_missing");
  const requestJson = parseJsonWithDuplicatePolicy(
    (
      await readStableArtifact(requestPath, MAX_EVM_WORKER_REQUEST_BYTES)
    ).bytes.toString("utf8"),
    "reject",
  );
  if (!requestJson.ok && requestJson.cause !== undefined)
    throw requestJson.cause;
  const request = requestSchema.parse(
    requestJson.ok ? requestJson.value : null,
  );
  const limits = selectedEvmProducerLimits(request.producer_limits);
  let reply: unknown;
  try {
    const bytes = decodeEvmBytecodeCarrier(
      (await readStableArtifact(request.snapshot_path, limits.input_bytes))
        .bytes,
      request.encoding,
    );
    if (bytes[0] === 0xef && bytes[1] === 0x00)
      throw new UnsupportedContainer(
        "Container marker EF00 is outside the verified flat-bytecode interface profile.",
      );
    const modulePath = import.meta.resolve("evmole/no_tla");
    const packageJson = parseJsonWithDuplicatePolicy(
      await readFile(new URL("../package.json", modulePath), "utf8"),
      "last-wins",
    );
    if (!packageJson.ok) throw packageJson.cause;
    const metadata = z
      .object({ version: z.literal(EVMOLE_VERSION) })
      .parse(packageJson.value);
    const engine = await import("evmole/no_tla");
    engine.initSync({
      module: await readFile(
        new URL(import.meta.resolve("evmole/evmole_bg.wasm")),
      ),
    });
    const raw = evmoleInterfaceReplySchema.parse(
      engine.contractInfo(Buffer.from(bytes).toString("hex"), {
        selectors: true,
        arguments: true,
        stateMutability: true,
      }),
    );
    reply = {
      ok: true,
      version: metadata.version,
      bytecode: {
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        hex: Buffer.from(bytes).toString("hex"),
        metadata: inspectSolidityMetadata(bytes),
      },
      raw,
    };
  } catch (cause: unknown) {
    reply = {
      ok: false,
      reason:
        cause instanceof EvmCarrierFailure
          ? "malformed"
          : cause instanceof UnsupportedContainer
            ? "unsupported"
            : "decoder",
      message: errorMessage(cause),
    };
  }
  let encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded) > limits.output_bytes)
    encoded = JSON.stringify({
      ok: false,
      reason: "output-limit",
      message: `Complete interface evidence exceeds producer_limits.output_bytes (${String(limits.output_bytes)} bytes).`,
    });
  try {
    await writeFile(request.reply_path, encoded, { flag: "wx", mode: 0o600 });
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "EFBIG") {
      try {
        await writeFile(request.failure_marker_path, "F", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (markerFailure: unknown) {
        process.stderr.write(
          `File-size failure marker unavailable: ${errorMessage(markerFailure)}\n`,
        );
      }
      process.exitCode = EVM_FILE_SIZE_FAILURE_EXIT;
    } else throw cause;
  }
};

await main();
