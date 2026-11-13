# Delphi/C++Builder binary form payload decoding

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the
[native binary diagnostics guide](../../../guides/native/binary-diagnostics.md).

## Problem and outcome

REA's PE resource inventory reports opaque RT_RCDATA payloads. Delphi and
C++Builder store a component tree in those payloads as a `TPF0`/`TPF1` filer
stream, so an analyst cannot inspect the form's class, component names,
properties or nested controls without opening the image in a Delphi IDE. Add a
static decode of the signed payloads and publish the result as `delphi_forms`
alongside the existing resource inventory.

## Requirements

- Decode RT_RCDATA payloads that begin with `TPF0` or `TPF1`, including any
  byte prefix before the signature.
- Retain the signature, source range and prefix bytes; do not assign meaning to
  a prefix.
- Decode the root component and recursively nested components with their filer
  flags, child position, class name, component name, properties and children.
- Decode `System.Classes.TValueType` ordinals as declared value types. Preserve
  scalar width and signedness, numeric source bytes and the decoded projection.
- Decode lists, sets, collections, strings, identifiers and binary values.
  Keep a collection item's position and every property's name and type.
- Record byte ranges and the original value bytes for every projection so a
  claim can be traced back to the resource payload.
- Decode strings with the resource's declared code page. When no page is
  declared, record the Delphi 7 ANSI default and `code_page_source: "default"`.
  When the host cannot label the declared page, preserve bytes and record
  `code_page_source: "unsupported"`. Do not map a page through a host alias
  that changes bytes outside the declared repertoire.
- Report undecodable value types and truncated streams as explicit unknowns.
  Stop at the first value that cannot be positioned instead of resynchronising
  on guessed bytes.
- Preserve completed length prefixes when a string or binary payload is
  truncated or a representation budget stops decoding.
- Bound retained objects, properties, values, text, structural values and the
  complete result. Charge representation expansion before allocation and share
  the remaining PE metadata allowance with the form decoder.
- Validate decoded property types and string labels against their declared
  value types before publishing Evidence. A stopped decode may keep an explicit
  unknown value.
- Keep decoding static: never execute the image, resolve classes, bind event
  handlers or inspect runtime form state.

## Acceptance

Synthesized fixtures cover a representative form with a nested button, scalar
values, sets, collections and binary values; all supported code pages and the
unsupported byte-preserving path; truncated long, wide, short and binary
lengths; stopped nested lists and collections; truncated property names;
reserved filer flag bits; budget exhaustion; and provider outputs that
misstate code pages or value types. The resource parser and Evidence service
exercise the same partial and malformed outputs. CLI/MCP acceptance validates
the published contract through both adapters.

A real Delphi-produced sample remains unverified in this record; synthetic
fixtures establish the implemented format behavior only.

## Out of scope

Resolving Pascal class semantics, event-handler binding, runtime form state,
DFM text conversion, image or control rendering, target execution and verdicts
about intent.
