import type { TargetFailureKind } from "../../../../src/domain/targetFailure.js";
import { targetFailureReaders } from "../registry.js";

/** Bytes no format owner of these operations claims: 64 bytes of 0x7f. */
const foreignBytes = (): Buffer => Buffer.alloc(64, 0x7f);

const foreign = (
  operation: string,
  kind: TargetFailureKind,
  format: string,
) => ({
  operation,
  cases: [
    {
      name: "foreign-bytes",
      kind,
      bytes: foreignBytes,
      facts: { format },
      identity: true,
    },
  ],
});

/**
 * Selected-file readers refuse bytes no owner claims before decoding any
 * structure, and keep the completed file identity they hashed. The kind is
 * what each owner reports today: a magic mismatch several owners still call
 * `malformed` is recorded as such until they report `unrecognized`.
 */
export default targetFailureReaders([
  foreign("inspect_python_pyc", "malformed", "python-pyc"),
  foreign("inspect_deb_package", "malformed", "deb"),
  foreign("inspect_rust_binary", "unsupported", "native-binary"),
  foreign("inspect_go_binary", "unsupported", "native-binary"),
  foreign("inspect_elf_notes", "malformed", "elf"),
  foreign("inspect_elf_dependencies", "malformed", "native-binary"),
  foreign("inspect_elf_debug_link", "malformed", "native-binary"),
  foreign("inspect_elf_unwind_ranges", "malformed", "native-binary"),
  foreign("inspect_devicetree", "unsupported", "native-binary"),
  foreign("inspect_pe_imports", "malformed", "native-binary"),
  foreign("inspect_kernel_module", "malformed", "native-binary"),
  foreign("inspect_apple_ips", "malformed", "apple-ips"),
  foreign("inspect_pe_load_config", "malformed", "native-binary"),
  foreign("inspect_pe_certificates", "malformed", "native-binary"),
  foreign("inspect_pe_resources", "malformed", "native-binary"),
  foreign("inspect_native_exports", "unsupported", "native-binary"),
  foreign("inspect_native_initializers", "malformed", "native-binary"),
  foreign("inspect_binary_hardening", "unsupported", "native-binary"),
]);
