# V8 cached-data compilation boundaries

## Analyst question

Which source-visible Node VM compilation sites declare or may receive cached
bytes, and which admitted artifact can be associated with those bytes?

## Scope and authority

Static application analysis recognizes member calls to `vm.Script` and
`vm.compileFunction` when the shared built-in callable owner establishes their
identity. Analysis reads admitted source and inventory only. It does not invoke
the target, validate V8 cache bytes, establish cache acceptance, or execute code.
Node separates compilation, cache rejection and subsequent execution; see the
[Node VM contract](https://nodejs.org/docs/latest-v24.x/api/vm.html).

## Owning facts

- Resolve complete callable identity after shared mutation facts settle. ESM
  default/namespace imports and proven CommonJS bindings use the same owner.
  Replaced methods do not establish VM authority.
- `cached_data_status` is `declared` for an explicit cachedData property,
  `absent` for proven omission, and `unknown` for unresolved options or argument
  spreads that can supply or shift the options position. Declaration does not
  prove a valid runtime value or successful cache use.
- A proven `fs.readFileSync` or awaited `fs/promises.readFile` can identify a
  cache path. Unawaited promises and unproven readers retain bounded source
  expressions. A supplied string alone is not proof that a file was read.
- Preserve the parsed path base through the worker boundary. Only a proven
  source-directory base permits an application inventory lookup. Relative
  literal paths depend on the unknown target working directory; source paths
  and unresolved expressions stay separate from resolved artifact identity.
- Graph cache boundaries remain explicit unknowns with source provenance.
  Absent sites do not add cache-boundary uncertainty. Summary counts describe
  declared compilations, never observed executions.

## Compatibility and verification

Existing source declarations and inventory remain available. Optional path-base
facts may be absent in historical analyses; omission does not prove a base.
Public application workflows verify worker serialization, summary and graph
projection with local files. No test that merely supplies cache-shaped bytes
establishes real V8 acceptance or target execution.
