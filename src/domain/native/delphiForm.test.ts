import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { delphiFormResourceSchema } from "./delphiForm.js";

describe("delphi form advertised schema", () => {
  it("keeps known fields and discriminators machine-readable", () => {
    const advertised = JSON.stringify(z.toJSONSchema(delphiFormResourceSchema));
    // The recursive positions relax only their child/item edges; every known
    // field and discriminator stays discoverable for generated clients.
    for (const field of [
      '"kind"',
      '"class_name"',
      '"component_name"',
      '"location"',
      '"value_type"',
      '"items"',
      '"children"',
      '"position"',
      '"declared_code_page"',
    ])
      expect(advertised).toContain(field);
  });

  it("advertises without recursive definitions", () => {
    const advertised = JSON.stringify(z.toJSONSchema(delphiFormResourceSchema));
    expect(advertised).not.toContain("__schema");
  });

  it("lets bounded recursive edges carry the known fields", () => {
    // A client validating the output against the advertised shape must accept
    // real nested components, not only `{}`.
    const bounded: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (
        typeof record.description === "string" &&
        record.description.startsWith("A nested form object")
      )
        bounded.push(record);
      Object.values(record).forEach(walk);
    };
    walk(z.toJSONSchema(delphiFormResourceSchema));

    expect(bounded.length).toBeGreaterThan(0);
    for (const node of bounded)
      expect(node.additionalProperties).not.toBe(false);
  });

  it("accepts a nested decoded result against the SDK-converted shape", () => {
    // A generated client validates the result it receives against the JSON
    // Schema produced after SDK conversion. Compiling that schema with Ajv and
    // validating a real decoded form — a nested component plus a structural
    // value — proves the bounded recursive edges do not reject actual data,
    // which inspecting the schema text alone cannot show.
    const range = { offset: 0, bytes: 4 };
    const text = {
      text: "TForm1",
      bytes_hex: "54466f726d31",
      code_page: "windows-1252",
      location: range,
    };
    const nestedComponent = {
      location: range,
      flags: ["ffChildPos"],
      child_position: null,
      class_name: text,
      component_name: null,
      properties: [],
      children: [],
      unknown: null,
    };
    const resource = {
      resource_index: 0,
      signature: "TPF0",
      version: "boVersion1",
      signature_location: range,
      prefix: null,
      declared_code_page: 1252,
      code_page: "windows-1252",
      code_page_source: "resource",
      root: {
        location: range,
        flags: [],
        child_position: null,
        class_name: text,
        component_name: null,
        properties: [
          {
            name: {
              text: "Caption",
              bytes_hex: "43",
              code_page: "windows-1252",
              location: range,
            },
            value_type: "vaString",
            value: {
              kind: "string",
              text: "Hi",
              bytes_hex: "4869",
              code_page: "windows-1252",
              truncated: false,
              location: range,
            },
            location: range,
          },
        ],
        children: [nestedComponent],
        unknown: null,
      },
    };

    const advertised = z.toJSONSchema(delphiFormResourceSchema);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(advertised);
    expect(validate(resource)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
