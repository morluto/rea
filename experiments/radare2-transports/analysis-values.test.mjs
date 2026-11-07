import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeGraph,
  decodeStructLayout,
  traceInputSchema,
} from "./analysis-values.mjs";
import { decodeHighPcode, traceFlow } from "./analysis-flow.mjs";

const graph = (base) => [
  {
    addr: base,
    name: "selected",
    size: 4,
    blocks: [
      {
        addr: base,
        size: 4,
        jump: "0xffffffffffffffff",
        ops: [{ addr: base, size: 4, type: "icall", opcode: "blr x8" }],
      },
    ],
  },
];

void test("CFG arithmetic preserves wide addresses and unresolved calls", () => {
  const result = decodeGraph(graph("0x20000000000001"));
  assert.equal(result.basic_blocks[0].end, "0x20000000000005");
  assert.deepEqual(result.basic_blocks[0].successors, []);
  assert.deepEqual(result.coverage.unresolved_calls, ["0x20000000000001"]);
  assert.throws(
    () => decodeGraph(graph(9_007_199_254_740_992)),
    /Invalid native unsigned integer/u,
  );
});

void test("native struct member sizes are already aggregate; ABI padding remains unknown", () => {
  const layout = decodeStructLayout(
    {
      name: "Buffer",
      fields: [
        { name: "words", offset: 0, size: 12, array_size: 3, type: "int" },
      ],
    },
    "Buffer",
  );
  assert.equal(layout.fields[0].size_bytes, 12);
  assert.equal(layout.size_bytes, null);
  assert.equal(layout.alignment_bytes, null);
  assert.throws(
    () => decodeStructLayout({ name: "Other", fields: [] }, "Buffer"),
    /identity/u,
  );
});

void test("non-default p-code spaces remain outside native CFG scope without losing operations", () => {
  const flow = decodeHighPcode(
    `<result><function name="selected">
    <addr space="ram" offset="0x1000"/>
    <ast><varnodes/><block index="0"><op code="10">
      <seqnum space="overlay custom" offset="0x2000" uniq="1"/><void/>
    </op></block></ast>
  </function></result>`,
    {
      procedure: { address: "0x1000" },
      basic_blocks: [{ start: "0x1000", end: "0x1004" }],
    },
  );
  assert.equal(flow.operations.length, 1);
  assert.deepEqual(flow.scope.native_body_external_operation_addresses, [
    "overlay%20custom:0x2000",
  ]);
});

void test("unobserved parameter flow retains source omissions and unknown selection", () => {
  const flow = {
    producer: "r2ghidra-pdgx",
    ir: "ghidra-high-pcode",
    operations: [],
    parameters: [],
    parameter_uses: [],
    def_use: [],
    effects: [],
    unknowns: [],
    limitations: [],
    truncated: true,
    omitted_operations_lower_bound: 1,
    known_omitted_inputs: 2,
    known_omitted_edges: 3,
  };
  const traced = traceFlow(
    flow,
    { address: "0x1000" },
    { parameter: 1, max_nodes: 10 },
  );
  assert.equal(traced.selection_status, "unknown");
  assert.equal(traced.truncated, true);
  assert.equal(traced.source_coverage.known_omitted_edges, 3);
  assert.match(traced.unknowns.join("\n"), /does not establish/u);
  assert.equal(
    traceInputSchema.safeParse({ procedure: "0x1000", value_flow: "none" })
      .success,
    false,
  );
});
