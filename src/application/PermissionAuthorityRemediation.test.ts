import { describe, expect, it } from "vitest";

import { PermissionAuthority } from "./PermissionAuthority.js";
import type { PermissionRequiredError } from "../domain/errors.js";
import {
  createPermissionPolicy,
  type PermissionRequest,
  type PermissionScope,
} from "../domain/permissionPolicy.js";

// Ceiling paths must exist: the policy canonicalizes them with realpath.
const ceilingScope: PermissionScope = {
  capability: "browser_automate",
  roots: [],
  executables: [process.execPath],
  origins: ["http://127.0.0.1:3000"],
  environment_names: [],
  network: "external",
  mount: false,
};

/** A request the administrator ceiling already fully covers. */
const coveredRequest = (
  overrides: Partial<PermissionScope> = {},
): PermissionRequest => ({
  ...ceilingScope,
  network: "loopback",
  operation_identity: "browser-scenario-1",
  ...overrides,
});

/** Narrow to the permission-denial error, failing the test on any other error. */
const denied = async (
  authority: PermissionAuthority,
  request: PermissionRequest,
  remediation?: "elicit",
): Promise<PermissionRequiredError> => {
  const result = await authority.authorize(
    request,
    "write",
    remediation === undefined ? {} : { remediation },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a denial");
  if (result.error._tag !== "PermissionRequiredError")
    throw new Error(`expected a permission denial, got ${result.error._tag}`);
  return result.error;
};

describe("permission denial remediation", () => {
  it("asks for a grant, not a wider ceiling, when the ceiling covers the scope", async () => {
    const authority = new PermissionAuthority(
      createPermissionPolicy([ceilingScope], []),
    );
    // The ceiling contains this scope, so widening it cannot help.
    expect(await denied(authority, coveredRequest())).toMatchObject({
      remediation: "grant",
    });
  });

  it("denies an empty request as needing a grant, not a ceiling violation", async () => {
    const authority = new PermissionAuthority(
      createPermissionPolicy([ceilingScope], []),
    );
    expect(
      await denied(authority, {
        capability: "browser_automate",
        roots: [],
        executables: [],
        origins: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: "browser-scenario-1",
      }),
    ).toMatchObject({ remediation: "grant" });
  });

  it("still points at configuration for a genuine ceiling violation", async () => {
    const authority = new PermissionAuthority(
      createPermissionPolicy([ceilingScope], []),
    );
    expect(
      await denied(
        authority,
        coveredRequest({ origins: ["https://not-configured.example"] }),
      ),
    ).toMatchObject({ remediation: "configure" });
  });

  it("keeps an explicitly requested elicit remediation untouched", async () => {
    const authority = new PermissionAuthority(
      createPermissionPolicy([ceilingScope], []),
    );
    expect(await denied(authority, coveredRequest(), "elicit")).toMatchObject({
      remediation: "elicit",
    });
  });
});
