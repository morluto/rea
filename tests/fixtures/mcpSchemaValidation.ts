import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/client";
import {
  addFormats,
  AjvJsonSchemaValidator,
} from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

/**
 * Compiled SDK validators keyed by full schema text, shared by every client in
 * the worker. A validator call is synchronous and keeps no state between
 * calls, so clients can share it. Compiling REA's largest advertised schema
 * allocates hundreds of MiB and takes most of a second, while the result
 * retains about 16 MiB; recompiling it for each connection dominated MCP test
 * memory. The count bound keeps workers that share a module graph across
 * files from retaining every catalog schema; least recently used goes first.
 */
export const SHARED_COMPILED_VALIDATORS = 32;
const sharedCompiledValidators = new Map<
  string,
  JsonSchemaValidator<unknown>
>();
const sharedCompiledValidator = (key: string): JsonSchemaValidator<unknown> => {
  let validator = sharedCompiledValidators.get(key);
  if (validator === undefined) {
    validator = compiledValidator(key);
    if (sharedCompiledValidators.size >= SHARED_COMPILED_VALIDATORS) {
      const oldest = sharedCompiledValidators.keys().next();
      if (oldest.done !== true) sharedCompiledValidators.delete(oldest.value);
    }
  } else sharedCompiledValidators.delete(key);
  sharedCompiledValidators.set(key, validator);
  return validator;
};

const compiledValidator = (key: string): JsonSchemaValidator<unknown> => {
  const schema = JSON.parse(key) as Record<string, unknown>;
  // Keep shared definitions as compiled functions instead of expanding them
  // at every reference. Other dialects retain SDK dispatch.
  const provider =
    schema.$schema === undefined ||
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? new AjvJsonSchemaValidator(
          addFormats(
            new Ajv2020({
              strict: false,
              validateFormats: true,
              validateSchema: false,
              allErrors: true,
              inlineRefs: false,
              code: { optimize: false },
            }),
          ),
        )
      : new AjvJsonSchemaValidator();
  // Each full schema owns its provider, including dialect dispatch.
  // Distinct schemas may legally reuse the same $id in separate servers.
  return provider.getValidator(schema as JsonSchemaType);
};

/** Share immutable schema preparation within one test file, never its sessions. */
export const createMcpSchemaValidation = () => {
  const sdkValidators = new Map<string, JsonSchemaValidator<unknown>>();
  const assertionValidators = new Map<string, ValidateFunction>();
  const meta = new Ajv2020({ strict: false, validateFormats: false });
  let errors: unknown = null;
  return {
    getValidator<T>(
      schema: JsonSchemaType | Readonly<Record<string, unknown>>,
    ): JsonSchemaValidator<T> {
      // Snapshot the schema now, so later caller mutation cannot change it.
      const key = JSON.stringify(schema);
      let validator = sdkValidators.get(key);
      if (validator === undefined) {
        // The SDK prepares a validator for every listed tool before its first
        // call. Compile on first use, so a session pays only for the tools it
        // calls; REA's full catalog otherwise costs seconds of compilation.
        let compiled: JsonSchemaValidator<unknown> | undefined;
        validator = (input) =>
          (compiled ??= sharedCompiledValidator(key))(input);
        sdkValidators.set(key, validator);
      }
      return validator as JsonSchemaValidator<T>;
    },
    assertions: {
      get errors() {
        return errors;
      },
      validateSchema(schema: Record<string, unknown>) {
        const valid = meta.validateSchema(schema);
        errors = meta.errors;
        return valid;
      },
      validate(schema: Record<string, unknown>, value: unknown) {
        const key = JSON.stringify(schema);
        let validator = assertionValidators.get(key);
        if (validator === undefined) {
          // Preserve the explicit assertions' existing options, independently
          // of the SDK default provider's format/all-errors policy.
          validator = new Ajv2020({
            strict: false,
            validateFormats: false,
            inlineRefs: false,
            code: { optimize: false },
          }).compile(JSON.parse(key));
          assertionValidators.set(key, validator);
        }
        const valid = validator(value);
        errors = validator.errors;
        return valid;
      },
    },
    clear() {
      sdkValidators.clear();
      assertionValidators.clear();
      meta.removeSchema();
      errors = null;
    },
  };
};
