import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";

/** Accumulate native search pages without mistaking the uint8 page limit for coverage. */
export class GrokCatalogDiscovery {
  #expected;
  #tools = new Map();
  #validator = new Ajv2020({ strict: false, validateFormats: false });
  pages = [];

  constructor(expectedNames) {
    this.#expected = new Set(expectedNames);
  }

  get size() {
    return this.#tools.size;
  }

  /** Return only an uncovered query; fail if a targeted search makes no progress. */
  accept(discovery, query) {
    assert.equal(discovery.status, "ready");
    assert(Array.isArray(discovery.results));
    const inventory = discovery.results
      .filter((result) => result.server === "rea")
      .flatMap((result) => result.tools);
    if (query !== "rea")
      assert(
        inventory.some((tool) => tool.tool_name === query),
        `Native search_tool did not return the requested missing tool ${query}`,
      );
    for (const tool of inventory) {
      assert(
        this.#expected.has(tool.tool_name),
        `Unexpected REA tool ${tool.tool_name}`,
      );
      if (this.#tools.has(tool.tool_name)) continue;
      assert(tool.input_schema, `${tool.tool_name}: missing input schema`);
      assert(
        this.#validator.validateSchema(tool.input_schema),
        `${tool.tool_name}: invalid advertised schema: ${JSON.stringify(this.#validator.errors)}`,
      );
      this.#tools.set(tool.tool_name, tool);
    }
    this.pages.push(discovery);
    return [...this.#expected].find((name) => !this.#tools.has(name));
  }
}
