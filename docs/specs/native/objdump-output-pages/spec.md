# Bounded objdump output pages

[Design discussion](https://github.com/morluto/rea/issues/8825)

An analyst should be able to read a small window of saved objdump stdout or
stderr while seeing exit status, truncation, completion and source identity.
The page contains exact retained text and uses UTF-16 code-unit offsets without
splitting a surrogate pair. Coverage describes the selected retained stream.
Existing summaries and complete Evidence remain usable.

## Acceptance

Reconstruct both retained streams through page continuations and exercise
Unicode, empty streams, producer truncation and caller-selected larger pages
subject to existing delivery limits.

## Non-goals

- Executing a command during a view request.
- Paging GDB output.
- Literal text search or format-specific interpretation.
