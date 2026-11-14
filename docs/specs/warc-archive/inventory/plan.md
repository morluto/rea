# Implementation plan

1. **Domain.** `src/domain/warcArchive/` owns the result schema and a parser that
   decodes the archive once, reads each record's header block within a bounded
   window, and records a diagnostic instead of guessing when a bound is reached
   or a line cannot be read.
2. **HTTP message.** A `request` or `response` payload is read from one bounded
   window, so a record that declares a large body costs the same as one that
   declares nothing. A payload that starts like HTTP but cannot be represented
   names its omission instead of reading as a non-HTTP body.
3. **Redaction.** Authentication and cookie header values are withheld and URL
   user information is replaced in one place, so every consumer sees the same
   redacted text.
4. **Contract and application.** `src/contracts/warcArchiveToolContracts.ts`
   declares one provider-free application contract; a shared verified file read
   owns the admission bound and Evidence construction, and the MCP and CLI
   adapters only deliver the retained Evidence.
5. **Tests and docs.** Parser tests per diagnostic and per bound, the guide under
   `docs/guides/data/`, the contract reference and this specification.
