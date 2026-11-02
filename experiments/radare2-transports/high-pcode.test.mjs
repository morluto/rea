import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHighPcode } from "./high-pcode.mjs";

const model = (varnodes, operations, extra = "") => `
<result><function><function name="fixture &amp; decoded">
  <addr space="ram" offset="0x20000000000001"/>
  ${extra}
  <ast><varnodes>${varnodes}</varnodes><block index="0">${operations}</block></ast>
</function></function><code><function><op>rendered text is not an AST operation</op></function></code></result>`;

const vn = (ref, offset = ref, flags = "", space = "register") =>
  `<addr ref="${ref}" space="${space}" offset="${offset}" size="8" ${flags}/>`;
const op = (sequence, code, operands) =>
  `<op code="${code}"><seqnum space="ram" offset="0x20000000000001" uniq="${sequence}"/>${operands}</op>`;
const ref = (id) => `<addr ref="${id}"/>`;
const value = (xml) => {
  const result = parseHighPcode(xml);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  return result.value;
};

void test("SSA references separate register versions and retain 64-bit identities", () => {
  const graph = value(
    model(
      vn("0x20000000000001", "0x4000", 'input="true"') +
        vn("0x20000000000002", "0x4000") +
        vn("0x20000000000003", "0xffffffffffffffff", "", "const") +
        vn("0x20000000000004", "0x4000"),
      op(1, 1, ref("0x20000000000002") + ref("0x20000000000001")) +
        op(
          2,
          19,
          ref("0x20000000000004") +
            ref("0x20000000000002") +
            ref("0x20000000000003"),
        ),
      `<localdb><scope><symbollist><mapsym>
      <symbol name="value" id="0x4000010000000001" cat="0" index="0" typelock="true"><typeref name="uint64_t"/></symbol>
      <addr space="register" offset="0x4000"/>
    </mapsym></symbollist></scope></localdb>
    <highlist><high class="param" symref="0x4000010000000001"><addr ref="0x20000000000001"/></high></highlist>`,
    ),
  );
  assert.equal(graph.procedure.name, "fixture & decoded");
  assert.equal(graph.procedure.address, "0x20000000000001");
  assert.equal(graph.operations[1].opcode, "INT_ADD");
  assert.equal(graph.operations[1].inputs[1].constant_hex, "ffffffffffffffff");
  assert.deepEqual(graph.def_use, [
    {
      definition: "0x20000000000001#1",
      use: "0x20000000000001#2",
      input_index: 0,
    },
  ]);
  assert.deepEqual(graph.parameter_uses, [
    { ordinal: 0, use: "0x20000000000001#1", input_index: 0 },
  ]);
  assert.equal(graph.parameters[0].binding_basis, "high-symbol-membership");
  assert.equal(graph.parameters[0].symbol_id, "0x4000010000000001");
  assert.equal(graph.operations[0].is_dead, null);
  assert.equal(graph.truncated, false);
});

void test("space and INDIRECT operation operands preserve positions and authority", () => {
  const graph = value(
    model(
      vn(1) + vn(2) + vn(3) + vn(4),
      op(1, 2, ref(2) + '<spaceid name="ram"/>' + ref(1)) +
        op(2, 61, ref(3) + ref(2) + '<iop value="0x1"/>') +
        op(3, 3, '<void/><spaceid name="ram"/>' + ref(1) + ref(3)) +
        op(4, 65, ref(4) + ref(1) + "<void/>" + ref(2)),
    ),
  );
  assert.equal(graph.operations[0].inputs[0].kind, "address-space");
  assert.equal(graph.operations[1].inputs[1].kind, "operation-reference");
  assert.equal(graph.operations[1].inputs[1].sequence, 1);
  assert.equal(graph.operations[2].output, null);
  assert.equal(graph.operations[3].opcode, "PTRADD");
  assert.equal(graph.operations[3].inputs[1].kind, "unavailable");
  assert.equal(graph.operations[3].inputs[2].ref, "0x2");
  assert.equal(
    graph.effects.find((effect) => effect.kind === "memory_write").value_input,
    2,
  );
  assert.equal(
    graph.def_use.filter((edge) => edge.use.endsWith("#2")).length,
    1,
  );
});

void test("anonymous pointer descriptors and an explicit void return survive parsing", () => {
  const graph = value(
    model(
      vn(1, "0x4008", 'input="true"'),
      op(1, 10, "<void/>" + ref(1)),
      `<localdb><scope><symbollist><mapsym>
      <symbol name="source" id="0x4000010000000002" cat="0" index="1">
        <type name="" size="8" metatype="ptr" core="true"><typeref name="void" id="0xc0feab8523c497cf"/></type>
      </symbol><addr space="register" offset="0x4008"/>
    </mapsym></symbollist></scope></localdb>
    <highlist><high class="param" symref="0x4000010000000002"><addr ref="1"/></high></highlist>
    <prototype model="__cdecl"><returnsym><addr/><void/></returnsym></prototype>`,
    ),
  );
  assert.equal(graph.parameters[0].data_type, null);
  assert.equal(graph.parameters[0].type_descriptor.attributes.metatype, "ptr");
  assert.equal(graph.parameters[0].type_descriptor.attributes.size, "8");
  assert.deepEqual(
    { ...graph.parameters[0].type_descriptor.children[0].attributes },
    {
      name: "void",
      id: "0xc0feab8523c497cf",
    },
  );
  assert.equal(graph.return_type.data_type, "void");
  assert.equal(graph.return_type.type_descriptor.name, "void");
  assert.equal(graph.return_type.storage, null);
});

void test("DTD, entities, malformed models and dangling SSA references fail explicitly", () => {
  for (const xml of [
    '<!DOCTYPE result [<!ENTITY secret SYSTEM "file:///etc/passwd">]><result>&secret;</result>',
    "<!DOCTYPE result><result/>",
    "<result><function></result>",
    "<result>&undefined;</result>",
    model(vn(1), op(1, 1, ref(1) + ref(999))),
    model(vn(1) + vn(1), op(1, 1, ref(1))),
    model(vn(1), op(1, 1, ref(1)) + op(1, 1, ref(1))),
    model(vn(1), op(1, 1, ref(1)) + op(2, 1, ref(1))),
    '<result><function name="missing model"/></result>',
  ]) {
    const result = parseHighPcode(xml);
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisOutputError");
  }
});

void test("unknown opcodes retain their numeric identity without invented semantics", () => {
  const graph = value(model(vn(1), op(1, 999, ref(1))));
  assert.equal(graph.operations[0].opcode, null);
  assert.equal(graph.operations[0].opcode_number, 999);
  assert.match(graph.unknowns.join("\n"), /Opcode 999/u);
});

void test("model budgets report omitted operations, inputs and SSA edges", () => {
  const varnodes = Array.from({ length: 3_003 }, (_, index) =>
    vn(index + 1),
  ).join("");
  const uses = ref(2).repeat(65);
  const operations =
    op(0, 1, ref(2) + ref(1)) +
    Array.from({ length: 3_001 }, (_, index) =>
      op(index + 1, 60, ref(index + 3) + uses),
    ).join("");
  const graph = value(model(varnodes, operations));
  assert.equal(graph.summary.total_operations, 3_002);
  assert.equal(graph.operations.length, 3_000);
  assert.equal(graph.def_use.length, 12_000);
  assert.equal(graph.omitted_operations_lower_bound, 2);
  assert.equal(graph.known_omitted_inputs, 2_999);
  assert.equal(graph.known_omitted_edges, 2_999 * 64 - 12_000);
  assert.equal(graph.truncated, true);
});

void test("XML capacity rejection is distinct from malformed producer output", () => {
  const result = parseHighPcode(" ".repeat(16 * 1024 * 1024 + 1));
  assert.equal(result.ok, false);
  assert.equal(result.error._tag, "AnalysisResourceConstraintError");
});

void test("operation and input subtrees are bounded during parsing with examined coverage", () => {
  const graph = value(
    model(
      vn(1),
      Array.from({ length: 30_000 }, (_, i) =>
        op(i, 10, "<void/>" + ref(1)),
      ).join(""),
    ),
  );
  assert.equal(graph.summary.total_operations, 30_000);
  assert.equal(graph.operations.length, 3_000);
  assert.equal(graph.omitted_operations_lower_bound, 27_000);
  assert.equal(graph.truncated, true);
  const wide = value(
    model(vn(1), op(0, 10, "<void/>" + ref(1).repeat(50_000))),
  );
  assert.equal(wide.operations[0].inputs.length, 64);
  assert.equal(wide.known_omitted_inputs, 50_000 - 64);
});

void test("tree and depth capacity fail before unbounded XML model allocation", () => {
  for (const xml of [
    model("<addr/>".repeat(220_000), ""),
    model(vn(1), "", "<type>".repeat(600) + "</type>".repeat(600)),
    "<wrapper>".repeat(600) + "</wrapper>".repeat(600),
  ]) {
    assert.ok(Buffer.byteLength(xml) < 16 * 1024 * 1024);
    const result = parseHighPcode(xml);
    assert.equal(result.error._tag, "AnalysisResourceConstraintError");
    assert.equal(result.error.partialObservation.coverage, "partial");
    assert.ok(result.error.partialObservation.retained_nodes <= 216_000);
  }
});

void test("retained operations follow producer order and unrelated metadata cannot consume their budget", () => {
  const xml = model(
    vn(1),
    op(2, 10, "<void/>" + ref(1)),
    "<metadata><ast><block>" +
      op(99, 10, "<void/>") +
      "</block></ast></metadata>",
  ).replace(
    "<ast><varnodes>",
    "<ast>" + op(1, 10, "<void/>" + ref(1)) + "<varnodes>",
  );
  const graph = value(xml);
  assert.equal(graph.summary.total_operations, 2);
  assert.deepEqual(
    graph.operations.map((operation) => operation.sequence),
    [1, 2],
  );
});
