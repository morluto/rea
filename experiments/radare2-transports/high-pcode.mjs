// Exploratory only: not registered as a REA provider or included in its package.
import { SaxesParser } from "saxes";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../dist/domain/analysisErrorCore.js";
import { err, ok } from "../../dist/domain/result.js";
import { MAX_JSON_DEPTH } from "../../dist/domain/jsonValue.js";

const OPERATION = "r2ghidra_high_pcode";
// The transport prototype admits at most 16 MiB of captured command output.
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_OPERATIONS = 3_000;
const MAX_INPUTS = 64;
const MAX_EDGES = 12_000;
// Bound model expansion independently of source bytes: one full input/output
// window plus eight metadata nodes per admitted operation. Type descriptors add
// object/children-array pairs; reserve 32 JSON levels for enclosing observations.
const MAX_TREE_NODES = MAX_OPERATIONS * (MAX_INPUTS + 8);
const MAX_TREE_DEPTH = Math.floor((MAX_JSON_DEPTH - 32) / 2);

// Numeric OpCode identities from Ghidra's opcodes.hh, also used by r2ghidra.
// Retain the numeric code: opcode 71 is EXTRACT in the inspected r2ghidra
// source, and was renamed ZPULL in newer Ghidra. Unknown codes stay unknown.
const OPCODES = `
  ? COPY LOAD STORE BRANCH CBRANCH BRANCHIND CALL CALLIND CALLOTHER RETURN
  INT_EQUAL INT_NOTEQUAL INT_SLESS INT_SLESSEQUAL INT_LESS INT_LESSEQUAL
  INT_ZEXT INT_SEXT INT_ADD INT_SUB INT_CARRY INT_SCARRY INT_SBORROW
  INT_2COMP INT_NEGATE INT_XOR INT_AND INT_OR INT_LEFT INT_RIGHT INT_SRIGHT
  INT_MULT INT_DIV INT_SDIV INT_REM INT_SREM BOOL_NEGATE BOOL_XOR BOOL_AND
  BOOL_OR FLOAT_EQUAL FLOAT_NOTEQUAL FLOAT_LESS FLOAT_LESSEQUAL ? FLOAT_NAN
  FLOAT_ADD FLOAT_DIV FLOAT_MULT FLOAT_SUB FLOAT_NEG FLOAT_ABS FLOAT_SQRT
  FLOAT_INT2FLOAT FLOAT_FLOAT2FLOAT FLOAT_TRUNC FLOAT_CEIL FLOAT_FLOOR FLOAT_ROUND
  MULTIEQUAL INDIRECT PIECE SUBPIECE CAST PTRADD PTRSUB SEGMENTOP CPOOLREF NEW
  INSERT EXTRACT POPCOUNT LZCOUNT
`
  .trim()
  .split(/\s+/u)
  .map((name) => (name === "?" ? null : name));

const invalid = (reason) => new AnalysisOutputError(OPERATION, reason);
const children = (node, name) =>
  node.children.filter((child) => child.name === name);
const one = (node, name, required = true) => {
  const matches = children(node, name);
  if (matches.length > 1 || (required && matches.length !== 1))
    throw invalid(
      `Expected ${required ? "one" : "at most one"} ${name} in ${node.name}`,
    );
  return matches[0];
};
const attribute = (node, name) => {
  const value = node.attributes[name];
  if (value === undefined || value === "")
    throw invalid(`Missing ${name} on ${node.name}`);
  return value;
};
const integer = (value, field) => {
  if (!/^(?:0x[\da-f]+|\d+)$/iu.test(value))
    throw invalid(`Invalid nonnegative integer for ${field}`);
  const parsed = BigInt(value);
  if (parsed > 0xffffffffffffffffn)
    throw invalid(
      `Integer exceeds the native 64-bit representation for ${field}`,
    );
  return parsed;
};
const hex = (value, field) => `0x${integer(value, field).toString(16)}`;
const count = (value, field) => {
  const parsed = integer(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER))
    throw invalid(`Unsafe count for ${field}`);
  return Number(parsed);
};
const coordinate = (space, offset) =>
  space === "ram" ? offset : `${encodeURIComponent(space)}:${offset}`;
const flag = (node, name) => {
  const value = node.attributes[name];
  if (value !== undefined && !["true", "false"].includes(value))
    throw invalid(`Invalid boolean ${name} on ${node.name}`);
  return value === "true";
};

function parseFunction(xml) {
  if (typeof xml !== "string") throw invalid("pdgx output must be XML text");
  const bytes = Buffer.byteLength(xml, "utf8");
  if (bytes > MAX_XML_BYTES)
    throw new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      "pdgx XML exceeds the transport prototype capture bound",
      { observed_bytes: bytes, maximum_bytes: MAX_XML_BYTES },
    );
  const parser = new SaxesParser();
  const stack = [];
  let root;
  let candidates = 0;
  let depth = 0;
  let skippedDepth = 0;
  let retainedNodes = 0;
  let examinedElements = 0;
  let totalOperations = 0;
  const capacity = (reason, limits) =>
    new AnalysisResourceConstraintError(OPERATION, "capacity", reason, limits, {
      partialObservation: {
        examined_elements: examinedElements,
        retained_nodes: retainedNodes,
        examined_operations: totalOperations,
        coverage: "partial",
      },
    });
  const node = (tag) => {
    if (retainedNodes >= MAX_TREE_NODES)
      throw capacity("pdgx model exceeds the bounded tree allocation budget", {
        maximum_nodes: MAX_TREE_NODES,
      });
    retainedNodes++;
    return { name: tag.name, attributes: tag.attributes, children: [] };
  };
  parser.on("doctype", () => {
    throw invalid("DTD and entity declarations are unsupported in pdgx XML");
  });
  parser.on("opentag", (tag) => {
    examinedElements++;
    if (++depth > MAX_TREE_DEPTH)
      throw capacity("pdgx nesting exceeds the JSON descriptor depth budget", {
        maximum_depth: MAX_TREE_DEPTH,
      });
    if (skippedDepth) {
      skippedDepth++;
      return;
    }
    // pdgx has wrapper and rendered-code <function> elements as well.
    if (
      stack.length === 0 &&
      tag.name === "function" &&
      tag.attributes.name !== undefined
    ) {
      candidates++;
      if (candidates > 1)
        throw invalid("pdgx contains multiple named functions");
      root = node(tag);
      stack.push(root);
    } else if (stack.length > 0) {
      const parent = stack.at(-1);
      const modelOperation =
        tag.name === "op" &&
        stack[1]?.name === "ast" &&
        (stack.length === 2 || (stack.length === 3 && parent.name === "block"));
      if (modelOperation) {
        totalOperations++;
        if (totalOperations > MAX_OPERATIONS) {
          skippedDepth = 1;
          return;
        }
      }
      if (
        parent.omittedInputs !== undefined &&
        parent.children.length >= MAX_INPUTS + 2
      ) {
        parent.omittedInputs = (parent.omittedInputs ?? 0) + 1;
        skippedDepth = 1;
        return;
      }
      const child = node(tag);
      if (modelOperation) child.omittedInputs = 0;
      parent.children.push(child);
      stack.push(child);
    }
  });
  parser.on("closetag", () => {
    depth--;
    if (skippedDepth) {
      skippedDepth--;
      return;
    }
    if (stack.length > 0) stack.pop();
  });
  parser.on("text", (text) => {
    if (skippedDepth) return;
    const node = stack.at(-1);
    if (node && text.trim()) node.text = (node.text ?? "") + text;
  });
  try {
    parser.write(xml).close();
  } catch (cause) {
    if (
      cause instanceof AnalysisOutputError ||
      cause instanceof AnalysisResourceConstraintError
    )
      throw cause;
    throw invalid("pdgx output is not well-formed XML");
  }
  if (root === undefined) throw invalid("pdgx has no named function model");
  return { root, totalOperations };
}

function varnode(node) {
  const space = attribute(node, "space");
  const offset = hex(attribute(node, "offset"), "varnode offset");
  return {
    ref: hex(attribute(node, "ref"), "varnode ref"),
    kind:
      space === "const"
        ? "constant"
        : space === "ram"
          ? "address"
          : ["register", "unique"].includes(space)
            ? space
            : "other",
    space,
    offset,
    size_bytes: count(attribute(node, "size"), "varnode size"),
    location: space === "const" ? null : coordinate(space, offset),
    constant_hex: space === "const" ? offset.slice(2) : null,
    // Varnode::encode omits these attributes when the flag is false.
    input: flag(node, "input"),
    persistent: flag(node, "persists"),
    address_tied: flag(node, "addrtied"),
    unaffected: flag(node, "unaff"),
    volatile: flag(node, "volatile"),
  };
}

function operand(node, varnodes) {
  if (node.name === "void") return { kind: "unavailable", ref: null };
  if (node.name === "spaceid")
    return { kind: "address-space", ref: null, space: attribute(node, "name") };
  if (node.name === "iop")
    return {
      kind: "operation-reference",
      ref: null,
      sequence: count(attribute(node, "value"), "iop sequence"),
    };
  if (node.name !== "addr")
    throw invalid(`Unsupported p-code operand element ${node.name}`);
  const ref = hex(attribute(node, "ref"), "operand ref");
  const value = varnodes.get(ref);
  if (value === undefined)
    throw invalid(`P-code references missing varnode ${ref}`);
  return value;
}

function parseOperations(ast, varnodes, unknowns) {
  const sources = ast.children.flatMap((block) =>
    block.name === "op"
      ? [{ op: block, block: null }]
      : block.name === "block"
        ? children(block, "op").map((op) => ({
            op,
            block: count(attribute(block, "index"), "block index"),
          }))
        : [],
  );
  const ids = new Set();
  return sources.map(({ op, block }) => {
    const seq = one(op, "seqnum");
    if (op.children[0] !== seq || op.children.length < 2)
      throw invalid(
        "P-code operation must contain a sequence followed by an output",
      );
    const address = coordinate(
      attribute(seq, "space"),
      hex(attribute(seq, "offset"), "operation offset"),
    );
    const sequence = count(attribute(seq, "uniq"), "operation sequence");
    const id = `${address}#${sequence}`;
    if (ids.has(id)) throw invalid(`Duplicate p-code operation ${id}`);
    ids.add(id);
    const code = count(attribute(op, "code"), "opcode");
    const opcode = OPCODES[code] ?? null;
    if (opcode === null)
      unknowns.add(
        `Opcode ${code} has no verified name in this parser's r2ghidra table`,
      );
    const output = operand(op.children[1], varnodes);
    if (output.kind !== "unavailable" && output.ref === null)
      throw invalid("P-code output must be a varnode or void");
    return {
      id,
      address,
      sequence,
      opcode,
      opcode_number: code,
      is_dead: null,
      block_membership: block === null ? "detached" : "member",
      block_index: block,
      inputs: op.children.slice(2).map((input) => operand(input, varnodes)),
      omittedInputs: op.omittedInputs ?? 0,
      output: output.kind === "unavailable" ? null : output,
    };
  });
}

function descendants(node, name) {
  const found = [];
  const pending = [node];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next.name === name) found.push(next);
    for (const child of next.children) pending.push(child);
  }
  return found;
}

function storage(node) {
  if (
    node === undefined ||
    node.attributes.space === undefined ||
    node.attributes.offset === undefined
  )
    return null;
  return {
    space: node.attributes.space,
    offset: hex(node.attributes.offset, "storage offset"),
    size_bytes:
      node.attributes.size === undefined
        ? null
        : count(node.attributes.size, "storage size"),
  };
}

function typeFacts(node) {
  const descriptor = node.children.find((child) =>
    ["type", "typeref", "void"].includes(child.name),
  );
  return {
    data_type:
      descriptor?.name === "void"
        ? "void"
        : descriptor?.attributes.name || null,
    type_descriptor: descriptor ?? null,
  };
}

function parseParameters(fn, varnodes, unknowns) {
  const localdb = one(fn, "localdb", false);
  const highlist = one(fn, "highlist", false);
  const parameters = [];
  const ordinals = new Set();
  for (const mapsym of localdb === undefined
    ? []
    : descendants(localdb, "mapsym")) {
    const symbol = one(mapsym, "symbol", false);
    if (symbol === undefined || symbol.attributes.cat !== "0") continue;
    const ordinal = count(attribute(symbol, "index"), "parameter ordinal");
    if (ordinals.has(ordinal))
      throw invalid(`Duplicate parameter ordinal ${ordinal}`);
    ordinals.add(ordinal);
    const symbolId = hex(attribute(symbol, "id"), "parameter symbol id");
    const location = storage(one(mapsym, "addr", false));
    const highSymbols = (
      highlist === undefined ? [] : children(highlist, "high")
    ).filter(
      (high) =>
        high.attributes.class === "param" &&
        high.attributes.symref !== undefined &&
        hex(high.attributes.symref, "high symbol ref") === symbolId,
    );
    let refs = highSymbols.flatMap((high) =>
      children(high, "addr").map((addr) =>
        hex(attribute(addr, "ref"), "parameter varnode ref"),
      ),
    );
    let binding = "high-symbol-membership";
    if (refs.length === 0 && location !== null) {
      refs = [...varnodes.values()]
        .filter(
          (value) =>
            value.input &&
            value.space === location.space &&
            value.offset === location.offset &&
            (location.size_bytes === null ||
              value.size_bytes === location.size_bytes),
        )
        .map((value) => value.ref);
      binding = "input-storage-match";
      if (refs.length !== 1) refs = [];
    }
    for (const ref of refs)
      if (!varnodes.has(ref))
        throw invalid(`Parameter references missing varnode ${ref}`);
    if (refs.length === 0) {
      binding = "unavailable";
      unknowns.add(
        `Parameter ${ordinal} has no unambiguous serialized varnode binding`,
      );
    }
    parameters.push({
      ordinal,
      name: symbol.attributes.name ?? null,
      ...typeFacts(symbol),
      symbol_id: symbolId,
      storage: location,
      binding_basis: binding,
      varnode_refs: [...new Set(refs)],
      type_locked: flag(symbol, "typelock"),
    });
  }
  if (localdb === undefined)
    unknowns.add("Parameter symbol metadata is absent");
  return parameters.sort((left, right) => left.ordinal - right.ordinal);
}

const EFFECTS = new Map([
  ["LOAD", ["memory_read", 1, null]],
  ["STORE", ["memory_write", 1, 2]],
  ["CBRANCH", ["conditional_branch", null, 1]],
  ["BRANCHIND", ["indirect_branch", 0, null]],
  ["CALL", ["direct_call", 0, null]],
  ["CALLIND", ["indirect_call", 0, null]],
]);

function indexDefinitions(operations) {
  const definitions = new Map();
  for (const op of operations) {
    if (op.output === null) continue;
    if (definitions.has(op.output.ref))
      throw invalid(`Multiple definitions for SSA varnode ${op.output.ref}`);
    definitions.set(op.output.ref, op.id);
  }
  return definitions;
}

function indexParameters(parameters) {
  const bindings = new Map();
  for (const parameter of parameters)
    for (const ref of parameter.varnode_refs) {
      if (bindings.has(ref))
        throw invalid(`Multiple parameters own varnode ${ref}`);
      bindings.set(ref, parameter.ordinal);
    }
  return bindings;
}

// Return the omitted-edge contribution independently of the owning relation.
function retainEdge(edges, edge) {
  if (edges.length >= MAX_EDGES) return 1;
  edges.push(edge);
  return 0;
}

function linkModel(all, parameters) {
  const definitions = indexDefinitions(all);
  const parametersByRef = indexParameters(parameters);
  const operations = all.map(({ omittedInputs: _omittedInputs, ...op }) => op);
  const defUse = [];
  const parameterUses = [];
  let omittedEdges = 0;
  let omittedInputs = 0;
  for (const op of all) {
    omittedInputs += op.omittedInputs;
    for (const [inputIndex, input] of op.inputs.entries()) {
      const definition = definitions.get(input.ref);
      if (definition !== undefined)
        omittedEdges += retainEdge(defUse, {
          definition,
          use: op.id,
          input_index: inputIndex,
        });
      const ordinal = parametersByRef.get(input.ref);
      if (ordinal !== undefined)
        omittedEdges += retainEdge(parameterUses, {
          ordinal,
          use: op.id,
          input_index: inputIndex,
        });
    }
  }
  const effects = operations.flatMap((op) => {
    const effect = EFFECTS.get(op.opcode);
    return effect === undefined
      ? []
      : [
          {
            operation: op.id,
            kind: effect[0],
            operand_input: effect[1],
            value_input: effect[2],
          },
        ];
  });
  return {
    operations,
    defUse,
    parameterUses,
    effects,
    omittedEdges,
    omittedInputs,
  };
}

/** Parse actual r2ghidra pdgx SSA references without inventing missing AST flags. */
export function parseHighPcode(xml) {
  try {
    const { root: fn, totalOperations } = parseFunction(xml);
    const ast = one(fn, "ast");
    const varnodes = new Map();
    for (const node of one(ast, "varnodes").children) {
      if (node.name !== "addr")
        throw invalid("Unexpected varnode model element");
      const value = varnode(node);
      if (varnodes.has(value.ref))
        throw invalid(`Duplicate varnode ${value.ref}`);
      varnodes.set(value.ref, value);
    }
    const unknowns = new Set([
      "pdgx does not serialize is_dead; its value remains unknown",
    ]);
    const all = parseOperations(ast, varnodes, unknowns);
    const parameters = parseParameters(fn, varnodes, unknowns);
    const {
      operations,
      defUse,
      parameterUses,
      effects,
      omittedEdges,
      omittedInputs,
    } = linkModel(all, parameters);
    const fnAddress = one(fn, "addr");
    const prototype = one(fn, "prototype", false);
    const returnSymbol =
      prototype === undefined ? undefined : one(prototype, "returnsym", false);
    const omittedOperations = totalOperations - operations.length;
    const truncated =
      omittedOperations > 0 || omittedInputs > 0 || omittedEdges > 0;
    return ok({
      available: true,
      producer: "r2ghidra-pdgx",
      ir: "ghidra-high-pcode",
      procedure: {
        name: attribute(fn, "name"),
        address: coordinate(
          attribute(fnAddress, "space"),
          hex(attribute(fnAddress, "offset"), "function offset"),
        ),
      },
      calling_convention: prototype?.attributes.model ?? null,
      return_type:
        returnSymbol === undefined
          ? null
          : {
              ...typeFacts(returnSymbol),
              storage: storage(one(returnSymbol, "addr", false)),
            },
      operations,
      def_use: defUse,
      effects,
      parameters,
      parameter_uses: parameterUses,
      summary: {
        operations: operations.length,
        total_operations: totalOperations,
        varnodes: varnodes.size,
        def_use_edges: defUse.length,
        parameter_uses: parameterUses.length,
        parameters: parameters.length,
        memory_reads: effects.filter((effect) => effect.kind === "memory_read")
          .length,
        memory_writes: effects.filter(
          (effect) => effect.kind === "memory_write",
        ).length,
        calls: effects.filter((effect) =>
          ["direct_call", "indirect_call"].includes(effect.kind),
        ).length,
      },
      truncated,
      omitted_operations_lower_bound: omittedOperations,
      known_omitted_inputs: omittedInputs,
      known_omitted_edges: omittedEdges,
      unknowns: [...unknowns],
      limitations: [
        "This is an isolated r2ghidra pdgx model, not a registered REA provider result. It intentionally does not satisfy nativeValueFlowSchema because that contract requires an is_dead boolean absent from this XML.",
        "Def-use links follow serialized SSA varnode references, never coincident register names or offsets. High-symbol membership binds parameter references; a unique input-storage match is an explicitly labeled fallback.",
        "High p-code, types and call signatures are decompiler observations, not original source or runtime execution. Memory alias dependencies, call side effects and unresolved indirect targets remain unknown.",
        "INDIRECT iop operands identify an operation sequence, not a numeric constant or data def-use edge. Address-space operands retain their named space without inventing its internal numeric identifier.",
        "At most 3000 operations, 64 inputs per retained operation and 12000 edges per relation are returned. Known omitted edges cover retained inputs; omitted operations and inputs can hide additional relationships.",
        "Excess operation/input subtrees are counted during XML scanning but not materialized or semantically validated. Definitions outside the retained window and relationships through omitted inputs remain unknown. The retained tree and all XML nesting have separate allocation/depth budgets.",
      ],
    });
  } catch (cause) {
    return err(
      cause instanceof AnalysisOutputError ||
        cause instanceof AnalysisResourceConstraintError
        ? cause
        : invalid("pdgx model could not be decoded"),
    );
  }
}
