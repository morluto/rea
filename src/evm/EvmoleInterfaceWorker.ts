import { EvmAdmissionError } from "./EvmAdmissionError.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { evmCompilerSelection } from "../domain/evm/evmInterface.js";
import type { SolcArtifact } from "../domain/evm/solcArtifact.js";
import { jsonParts } from "../domain/jsonSerialization.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  decodeEvmBytecodeCarrier,
  EvmCarrierFailure,
} from "./EvmBytecodeCarrier.js";
import { selectSolcArtifact } from "../domain/evm/solcArtifactSelection.js";
import { evmWorkerRequestSchema } from "./EvmInterfaceWorkerContract.js";
import { evmoleInterfaceReplySchema } from "./EvmoleInterfaceAdapter.js";
import { inspectSolidityMetadata } from "./SolidityMetadata.js";
import { EVM_FILE_SIZE_FAILURE_EXIT } from "./EvmoleRelease.js";

class UnsupportedContainer extends Error {}

/** Admit bounded encoded parts before allocating a complete worker reply. */
const encodeReply = (
  reply: unknown,
  budget: number,
): Result<string, { reason: "output-limit"; message: string }> => {
  const parts: string[] = [];
  let bytes = 0;
  for (const part of jsonParts(reply)) {
    bytes += Buffer.byteLength(part);
    if (bytes > budget) {
      parts.length = 0;
      return err({
        reason: "output-limit",
        message: `Complete interface evidence exceeds the ${String(budget)} byte reply budget.`,
      });
    }
    parts.push(part);
  }
  return ok(parts.join(""));
};

const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined)
    throw new EvmAdmissionError("request_path_missing");
  const request = evmWorkerRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  let reply: unknown;
  let compilerFailureContext:
    | {
        compiler_diagnostics?: SolcArtifact["diagnostics"];
        carrier_sha256: string;
      }
    | undefined;
  try {
    const carrier = await readFile(request.snapshot_path);
    const compilerSelection = evmCompilerSelection(request.encoding);
    if (compilerSelection !== undefined)
      compilerFailureContext = {
        carrier_sha256: createHash("sha256").update(carrier).digest("hex"),
      };
    const selected =
      compilerSelection === undefined
        ? null
        : selectSolcArtifact(carrier, compilerSelection);
    if (selected !== null && !selected.ok) {
      if (
        selected.error.compiler_diagnostics !== undefined &&
        compilerFailureContext !== undefined
      )
        compilerFailureContext = {
          ...compilerFailureContext,
          compiler_diagnostics: selected.error.compiler_diagnostics,
        };
      reply = {
        ok: false,
        reason: selected.error.reason,
        message: selected.error.message,
        ...compilerFailureContext,
      };
    } else {
      const compilerArtifact = selected?.ok
        ? selected.value.artifact
        : undefined;
      if (
        compilerArtifact !== undefined &&
        compilerFailureContext !== undefined
      )
        compilerFailureContext = {
          ...compilerFailureContext,
          compiler_diagnostics: compilerArtifact.diagnostics,
        };
      let bytes: Uint8Array | null;
      if (selected?.ok) bytes = selected.value.bytes;
      else if (typeof request.encoding === "string")
        bytes = decodeEvmBytecodeCarrier(carrier, request.encoding);
      else
        throw new Error("Compiler encoding has no parsed compiler selection.");
      const compilerFacts =
        compilerArtifact === undefined
          ? {}
          : {
              compiler_artifact: compilerArtifact,
              carrier_sha256: compilerFailureContext?.carrier_sha256,
            };
      if (bytes === null) {
        reply = {
          ok: true,
          version: "0.9.3",
          bytecode: {
            sha256: null,
            bytes: selected?.ok ? selected.value.byteLength : null,
            hex: null,
            metadata: null,
          },
          raw: null,
          ...compilerFacts,
        };
      } else {
        if (bytes[0] === 0xef && bytes[1] === 0x00)
          throw new UnsupportedContainer(
            "Container marker EF00 is outside the verified flat-bytecode interface profile.",
          );
        const modulePath = import.meta.resolve("evmole/no_tla");
        const metadata = z
          .object({ version: z.literal("0.9.3") })
          .parse(
            JSON.parse(
              await readFile(new URL("../package.json", modulePath), "utf8"),
            ),
          );
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
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            hex: Buffer.from(bytes).toString("hex"),
            metadata: inspectSolidityMetadata(bytes),
          },
          raw,
          ...compilerFacts,
        };
      }
    }
  } catch (cause: unknown) {
    reply = {
      ok: false,
      reason:
        cause instanceof EvmCarrierFailure
          ? "format"
          : cause instanceof UnsupportedContainer
            ? "unsupported"
            : "decoder",
      message: cause instanceof Error ? cause.message : String(cause),
      ...compilerFailureContext,
    };
  }
  const admitted = encodeReply(reply, request.file_size_bytes);
  let encoded: string;
  if (admitted.ok) encoded = admitted.value;
  else {
    const failure = encodeReply(
      {
        ok: false,
        ...admitted.error,
        ...compilerFailureContext,
      },
      request.file_size_bytes,
    );
    encoded = failure.ok
      ? failure.value
      : JSON.stringify({
          ok: false,
          ...admitted.error,
          ...(compilerFailureContext === undefined
            ? {}
            : {
                carrier_sha256: compilerFailureContext.carrier_sha256,
                compiler_diagnostics_omitted: "reply-budget",
              }),
        });
  }
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
          `File-size failure marker unavailable: ${markerFailure instanceof Error ? markerFailure.message : String(markerFailure)}\n`,
        );
      }
      process.exitCode = EVM_FILE_SIZE_FAILURE_EXIT;
    } else throw cause;
  }
};

await main();
