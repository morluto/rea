# Capability composition and ownership

REA keeps domain contracts and shared workflows separate from provider adapters
and CLI/MCP translation. A capability can have several provider identities; a
provider can contribute operations to several capabilities. Those associations
are source facts, while host availability is an observation.

## Source declarations and runtime bindings

`src/composition/capabilityDeclarations.ts` contains the static provider identities
and canonical operation names. Its imports are pure metadata leaves; it must not
import factories, validators, engines or generated catalogs. Catalog generation
joins these names to the canonical contracts and rejects unknown operations and
conflicting identities. New provider provenance must come from the implementation
that actually produces the Evidence, including format-specific capture adapters
and derived workflows.

`src/composition/capabilityServices.ts` binds typed service factories to those
capability keys. Each runtime entry owns construction, cleanup and any available
host/configuration facts or live probes. A service entry requires a close
capability; entries adapting managers retain their existing `closeAll` operation.
The host maps entries without erasing their individual service/port types. There
is no generic JSON operation dispatcher.

These two declarations have different loading needs. Static facts can be read
without loading a schema or provider graph. The full runtime composition is
materialized only when the MCP runtime needs it. One-shot CLI adapters import the
selected factory rather than constructing a complete capability host. CLI and MCP
reuse the same provider/service factories and application workflows, while
keeping their respective argument translation and lifetime.

## Resource lifetime

`CapabilityScope` registers a module's actual close capability when its instance
is composed. There is no independent server provider-close list to update.
Concurrent shutdown calls join the same cleanup attempt. A successful peer is
removed from pending cleanup; failed peers remain owned and are retried on the
next close. Synchronous throws and rejections without a reason remain failures,
and cannot prevent other peers from attempting cleanup. Shutdown seals further
ownership registration.

The host distinguishes these lifetimes:

- Host-owned service instances are released by that host.
- Caller-owned optional observations remain borrowed by SDK server instances;
  their process-level owner closes them, including discarded discovery probes.
- CLI invocations use their existing finalizers to join cleanup and preserve the
  original observation, cancellation and cleanup errors.
- Binary engines, bundle readers and investigation records retain their existing
  owners. The `BinarySession` transition/drain barrier still coordinates target
  changes, reset and disposal. A module refactor must not create independent
  barriers that allow late work to repopulate reset records.

An application workflow may borrow a shared resource scope, such as byte entropy
using the host's artifact scope. Its wrapper does not acquire a second ownership
claim over the borrowed scope.

## Availability and registration

Module bindings provide host support, selected configuration and precisely typed
live availability probes through `CapabilityAvailabilityFacts`. Constructors do
not run these probes or launch engines. Session discovery invokes the existing
provider-owned probes only for advertised families; live failures remain fresh
observations. Caller policy, selected environments and injected providers retain
their existing precedence.

MCP registration remains in the MCP adapter. It consumes composed services,
record ports, admission and logging; it must not add fallback constructors that
can escape the host owner. Named contracts bind handlers and schemas. The complete
tool-family registrar map is checked by TypeScript, and catalog order never
selects a handler or schema.

## Extending a capability

1. Add or reuse the domain contract and application workflow, with explicit
   Evidence provenance, coverage, unknowns and caller choices.
2. Put concrete construction in `src/composition/` and keep its default factory
   lazy. Reference adapter-owned pure identity metadata from both the provider
   and its static capability declaration.
3. Add the runtime binding if a host-owned service is needed. Bind cleanup and
   availability/probes there, preserving borrowed versus owned resources.
4. Add the CLI/MCP argument adapters and their named registrations. A one-shot
   command uses the shared selected factory and existing finalization helpers.
5. Run source-boundary, discovery, SDK-schema and relevant public workflow checks.
   Exercise partial cleanup, retry, cancellation and caller-owned peers at the
   applicable production seam; use actual applications/providers for routing and
   complete Evidence verification. Recording ports do not prove real providers.

The constructor boundary guard covers the centralized Frida, Cutter, GDB and
Rizin constructors without rejecting legitimate type-only injected interfaces.
Other settled pure/provider boundaries continue checking type imports too. The
shared parser records import kind once, including inline type bindings and
static dynamic imports. Tests belong with their semantic owner and must be
found exactly once; provider roots need the corresponding adapter discovery lane.

This is an internal composition contract. External plugin distribution, automatic
provider installation and a universal provider interface are separate concerns.
