// Isolated native ESIL DFG experiment; no Ghidra plugin or target execution.
import { z } from "zod";
import {
  AnalysisArtifactChangedError,
  AnalysisInputError,
} from "../../dist/domain/analysisErrorCore.js";
import { err, ok } from "../../dist/domain/result.js";
import { observationError } from "./observation-error.mjs";

const OPERATION = "radare2_native_esil_slice";
const ADDRESS_LIMIT = 1n << 64n;
export const nativeEsilInputSchema = z.strictObject({
  address: z.string().regex(/^0x[\da-f]{1,16}$/iu),
  instruction_count: z.number().int().min(1).max(64),
  register: z.string().regex(/^[a-zA-Z_][a-zA-Z_0-9]*$/u),
});

const unsigned = (value, field) => {
  if (
    !(
      (typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0) ||
      (typeof value === "string" && /^(?:0x[\da-f]+|\d+)$/iu.test(value))
    )
  )
    throw new Error(`Invalid native ${field}`);
  const parsed = BigInt(value);
  if (parsed >= ADDRESS_LIMIT)
    throw new Error(`Native ${field} exceeds 64 bits`);
  return parsed;
};
const hex = (value) => `0x${value.toString(16)}`;

// The leading command quote bypasses r2 substitution, pipes, grep and command
// separators. The inner argv parser (r_str_argv) has different rules from JSON:
// it preserves backslash plus the next character, and quotes select argv scope.
// Switch quote scopes to retain a literal double quote without adding escapes.
function literalArgument(value) {
  if (/[\0\r\n]/u.test(value))
    throw new Error(
      "Native ESIL contains a NUL or line boundary unsupported by this command channel",
    );
  let quoted = '"';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      if (index + 1 === value.length)
        throw new Error(
          "A final unpaired ESIL backslash cannot precede another r_str_argv argument losslessly",
        );
      quoted += character + value[++index];
    } else if (character === '"') {
      quoted += ['"', "'", '"', "'", '"'].join("");
    } else {
      quoted += character;
    }
  }
  return quoted + '"';
}

function instructionsFrom(observation, input) {
  const reply = observation.replies?.[0];
  if (reply?.command_outcome !== "no_error_reported")
    throw new Error(
      "Native instruction decoding reported an error; status and logs are retained",
    );
  const instructions = reply.res;
  if (
    !Array.isArray(instructions) ||
    instructions.length !== input.instruction_count
  )
    throw new Error(
      "Native instruction coverage differs from the requested count",
    );
  let next = BigInt(input.address);
  for (const instruction of instructions) {
    if (instruction === null || typeof instruction !== "object")
      throw new Error("Native instruction record is malformed");
    if (unsigned(instruction.addr, "instruction address") !== next)
      throw new Error(
        "Native instruction addresses are not contiguous from the selected address",
      );
    const size = unsigned(instruction.size, "instruction size");
    if (size === 0n || next + size > ADDRESS_LIMIT)
      throw new Error("Native instruction has an invalid extent");
    if (
      typeof instruction.type !== "string" ||
      /(?:jmp|jump|call|ret|trap|swi|syscall|switch|invalid|unknown|^unk$|^ill$)/iu.test(
        instruction.type,
      )
    )
      throw new Error(
        "Straight-line ESIL slices do not cross branch, call, return, trap or unknown instructions",
      );
    if (typeof instruction.esil !== "string" || instruction.esil.trim() === "")
      throw new Error("A selected native instruction has no ESIL lift");
    next += size;
  }
  return { instructions, end_exclusive: hex(next) };
}

function targetConsistency(first, second) {
  const identities = [first, second].flatMap((target) => [
    target?.sha256_before,
    target?.sha256_after,
  ]);
  const known = identities.filter(
    (identity) => identity !== null && identity !== undefined,
  );
  if (
    known.some(
      (identity) =>
        typeof identity !== "string" || !/^[\da-f]{64}$/u.test(identity),
    )
  )
    throw new Error("Native observation has an invalid target digest");
  if (new Set(known).size > 1)
    throw new AnalysisArtifactChangedError(
      OPERATION,
      first?.path ?? second?.path ?? "unverified-external-core",
      "Target digest changed between native instruction decoding and DFG reduction",
    );
  const external = [first, second].some(
    (target) =>
      target?.core_binding === "unverified-external-core" ||
      target?.endpoint != null,
  );
  return {
    status: external
      ? "unverified-external-core"
      : known.length === 4
        ? "matching-artifact-digests"
        : "unknown",
    observations: [first ?? null, second ?? null],
    limitations: [
      "Matching artifact digests do not establish identical live core configuration, register state or analysis metadata across reads.",
      ...(external
        ? [
            "External HTTP core identity and freshness remain unverified; this is not a verified binding to a local artifact.",
          ]
        : []),
    ],
  };
}

function projectSlice({
  selected,
  observations,
  instructions,
  end_exclusive,
  expression,
}) {
  const [first, second] = observations;
  const consistency = targetConsistency(first.target, second.target);
  const reply = second.replies?.[0];
  if (
    reply?.command_outcome !== "no_error_reported" ||
    typeof reply.res !== "string"
  )
    throw new Error(
      "Native DFG reduction failed or did not return text; status and logs are retained",
    );
  const logs = observations.flatMap((observation, stage) =>
    (observation.replies?.[0]?.logs ?? []).map((log) => ({
      stage: stage === 0 ? "instructions" : "reduction",
      ...log,
    })),
  );
  const partialReasons = [];
  if (
    logs.some(
      (log) =>
        /^(?:WARN|WARNING)$/iu.test(log.type) ||
        /Invalid node/iu.test(log.message),
    )
  )
    partialReasons.push(
      "Native DFG emitted warning diagnostics; the reduction may omit dependencies",
    );
  if (
    expression
      .split(",")
      .some((token) => token.trim() === "?{" || token.trim() === "GOTO")
  )
    partialReasons.push(
      "Native ESIL DFG follows one conditional arm and bounds backward GOTO traversal; alternate dependencies remain unknown",
    );
  const empty = reply.res.trim() === "";
  if (empty)
    partialReasons.push(
      "Native DFG returned no reduced expression; this does not prove the register is independent",
    );
  return ok({
    input: selected,
    target: second.target,
    result: {
      producer: "radare2-native-aegf",
      ir: "esil-dfg-slice",
      status: partialReasons.length ? "partial" : "observed",
      address: selected.address,
      end_exclusive,
      register: selected.register,
      instructions,
      expression,
      reduced_expression: reply.res,
      coverage: {
        instruction_count: instructions.length,
        scope: "selected-straight-line-instructions",
        partial_reasons: partialReasons,
      },
      command_outcomes: observations.map((observation) => {
        const { error, code, value, command_outcome } = observation.replies[0];
        return {
          error,
          code,
          ...(value === undefined ? {} : { value }),
          command_outcome,
        };
      }),
      logs,
      target_consistency: consistency,
      limitations: [
        "This is native ESIL DFG reduction for a selected straight-line instruction slice, not a whole-function SSA or interprocedural analysis.",
        "A reduced expression is a producer dependency observation, not proof of complete dependencies, memory aliasing, call effects, feasible paths or observed execution.",
        "Every selected instruction must have a native ESIL lift; instruction-level branches, calls, returns, traps and unknown operations are refused.",
        ...consistency.limitations,
      ],
    },
    raw: {
      instruction_observation: first,
      reduction_observation: second,
    },
  });
}

/** Read native instruction lifts, then ask aegf for one register's DFG slice. */
export async function sliceNativeEsil(input, read) {
  const parsed = nativeEsilInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      new AnalysisInputError(OPERATION, {
        userMessage:
          "Select a hexadecimal address, 1–64 instructions and one register identifier",
      }),
    );
  const selected = {
    ...parsed.data,
    address: hex(BigInt(parsed.data.address)),
  };
  const observations = [];
  let expression;
  try {
    const decoded = await read([
      {
        cmd: `aoj ${selected.instruction_count} @ ${selected.address}`,
        json: true,
      },
    ]);
    if (!decoded.ok) return decoded;
    observations.push(decoded.value);
    const { instructions, end_exclusive } = instructionsFrom(
      decoded.value,
      selected,
    );
    expression = instructions.map((instruction) => instruction.esil).join(",");
    const command = `'aegf ${literalArgument(expression)} ${selected.register}`;
    const reduced = await read([{ cmd: command, json: false }]);
    if (!reduced.ok) {
      const failure = reduced.error;
      return err(
        observationError(
          failure,
          OPERATION,
          "Native DFG reduction read failed; the earlier instruction observation is retained",
          {
            input: selected,
            instruction_observation: decoded.value,
          },
        ),
      );
    }
    observations.push(reduced.value);
    return projectSlice({
      selected,
      observations,
      instructions,
      end_exclusive,
      expression,
    });
  } catch (cause) {
    return err(
      observationError(
        cause,
        OPERATION,
        cause?.message ?? "Cannot interpret native ESIL reduction",
        {
          input: selected,
          expression: expression ?? null,
          observations,
        },
      ),
    );
  }
}
