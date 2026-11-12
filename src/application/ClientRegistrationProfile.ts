import type { ClientRegistrationDialect } from "./ClientConfigurationDocument.js";

/** Proven native conditions incompatible with selecting the retained stdio launcher. */
export type NativeStdioIncompatibility =
  | {
      readonly kind:
        | "truthy"
        | "non-nullish"
        | "present"
        | "missing"
        | "nullish"
        | "string"
        | "invalid-string";
      readonly field: string;
    }
  | {
      readonly kind: "required-enum" | "optional-enum";
      readonly field: string;
      readonly values: readonly string[];
    }
  | { readonly kind: "equals"; readonly field: string; readonly value: string }
  | {
      readonly kind: "all";
      readonly conditions: readonly NativeStdioIncompatibility[];
    };

/** Native connection semantics, separate from the format storing the document. */
export type ClientRegistrationConnectionProfile =
  | {
      readonly kind: "flat";
      /** Proven native selectors/aliases in addition to canonical stdio fields. */
      readonly fields: readonly string[];
      readonly stdio: readonly NativeStdioIncompatibility[];
    }
  | { readonly kind: "cline" }
  | { readonly kind: "commandcode" }
  | {
      readonly kind: "stdio-only";
      /** Documented local members; other row members leave write applicability unknown. */
      readonly documentedFields: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Resolved by the client definition owner, never inferred from display text. */
export interface ClientRegistrationProfile {
  readonly nativeClient: string;
  readonly connection: ClientRegistrationConnectionProfile;
}

export interface ClientRegistrationTarget {
  readonly dialect: ClientRegistrationDialect;
  readonly profile: ClientRegistrationProfile;
}
