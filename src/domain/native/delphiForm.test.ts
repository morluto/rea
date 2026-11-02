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
});
