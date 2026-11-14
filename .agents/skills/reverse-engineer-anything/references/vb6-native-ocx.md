# Static VB6 native OCX/DLL investigations

Use this workflow for an authorized Visual Basic 6 native-code investigation
with the existing [native-target tools](native-and-artifacts.md#native-targets).
It adds no VB6 decoder or provider and does not establish that every provider
recovers VB6 metadata. P-Code, original source text, and runtime equivalence
are separate questions.

## Establish the representation

Preserve target identity and original byte ranges. A `.ocx` or `.dll` suffix,
PE32 architecture, or `MSVBVM60.DLL` import alone does not establish VB6 native
code. Corroborate candidate VB project/object metadata with method-table links,
thunks and native entry instructions. If the available tools do not establish
compilation mode or metadata layout, retain that uncertainty; do not interpret
P-Code as ordinary x86 procedure bodies.

TYPELIB declarations can establish public interface facts without recovering
implementation. Keep interface/member identity, native entry binding, and
inferred private declarations distinct. A shared field offset or vtable slot
in another class does not identify the same receiver or property.

## Reuse bounded native evidence

Check the current session and existing Evidence before reopening the target or
repeating analysis. Use a focused `analyze_function` request when needed. Page
its retained native facts with `inspect_analysis_view` where advertised;
preserve the exact source reference, returned coverage and provider limitations.
Do not interpret page exhaustion as complete source recovery.

Inspect the function's reported ranges and raw instructions, including warnings
about incomplete control flow. A linear window can also contain padding or the
next entry. A known distant cleanup address does not make its body covered.
Use the provider's address-to-file mapping to corroborate selected original
bytes; distinguish loaded-image fixups from unchanged file bytes.

## Recognize patterns without promoting guesses

Use compiler/runtime patterns to prioritize hypotheses, not as proof by name:

| Candidate family              | Evidence needed before reconstruction                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Scalar/String field accessors | Own receiver adjustment, field width/offset, thunk/helper binding and supported signature.                    |
| Object accessors              | Get/Set distinction, interface evidence and reference semantics; do not merge PutMemObj or NewObj variants.   |
| Variant/String conversions    | Latest tag/payload writes, pointer depth, captured values, copyback and ownership of each temporary.          |
| Array/bounds operations       | Descriptor evidence, lower bound/count/stride, signed or unsigned guard, and actual failure successors.       |
| Cleanup/error handling        | Normal, callback and exceptional entry paths, continuation mechanism, resource lifetimes and return channels. |

Helper names or ordinal annotations are hypotheses until their identities and
applicable runtime contracts are corroborated. Reuse compatible retained proof
and fixtures; do not transplant another function's inferred prototype.

## Preserve the differences that change behavior

- A WORD store does not clear the surrounding DWORD or all 16 Variant bytes.
  Empty, Null, a null BSTR and an allocated empty String are distinct.
- A returned conversion value is not automatically its ByRef input copyback.
  Preserve capture versus reread and the actual order of concatenation operands.
- Do not assume a bounds-error helper never returns. Retain observed fallback
  paths, signedness, overflow and unresolved helper effects.
- Public retval/hidden-out, Boolean WORD, native EAX and HRESULT are separate
  channels. Cleanup can change a native return register.
- A jump to shared cleanup followed by RET is not necessarily exception entry
  or fallthrough through a callback. A borrowed receiver after Release is not
  automatically usable.
- Literals and method names do not establish a business rule, database schema
  or document-validation algorithm.

## State the recovery boundary

For each conclusion, cite the original address/range and Evidence, distinguish
observation from interpretation, and list the remaining unknowns. Keep partial
pseudocode separate from an integrated implementation and use technical names
where originals are unavailable. An identified public interface can coexist
with an unrecovered body.

A closed instruction map, a compilable candidate, or a matching compiler fixture
does not establish the original source text or whole-component equivalence.
Any compiler experiment needs its own authorization and tool/license boundary;
compilation does not authorize execution, COM activation or registration.

Keep this investigation static unless a separate runtime question and its
execution/mutation scope have been reviewed. Do not load or register an OCX
merely to inspect its declarations. Record unsupported metadata and incomplete
control flow rather than synthesizing missing behavior.
