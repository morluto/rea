# Implementation plan

`src/server/UpdateNotices.ts` owns the registry lookup, the per-connection
observation, the 24-hour interval, the set of attempted versions and
cancellation. `configuredUpdateNoticeFactory` reads the opt-in and returns a
factory, or nothing when checks stay offline. It imports no provider or
application code.

`EvidenceMcpServerCore` holds the optional factory. `connect` creates one
`UpdateNotices` per transport, registers the logging capability only when a
factory is present, and passes the instance to `ErrorEvidenceTransport`. The
server tracks the instances it created so that `close` can cancel and join their
lookups together with the SDK shutdown, including after a transport has already
closed. Cleanup failures from both sides are reported together.

`ErrorEvidenceTransport` calls `refresh` when a `tools/call` request arrives and
never awaits it. When a tool result that is not an error is about to be
published, it peeks the pending notice, measures the complete notification
against the delivery's receive budget, records the attempt and sends the
notification through the SDK's logging helper without awaiting it. The SDK keeps
log-level filtering. An async-local request id attaches `relatedRequestId` to
that notification inside the transport's `send`, because the SDK helper does not
expose transport routing. The tool result itself is published unchanged.

Lookup cancellation passes `OwnerCancellation.deadlineElapsed` for the deadline
and `OwnerCancellation.ownerClosed` for close as abort reasons.

Composition sets the factory in two places: `src/main/deferredRuntime.ts` on the
deferred server, and `src/server/createServer.ts` when it constructs the server
itself. A server supplied by the deferred runtime keeps the factory it already
has.

The owning contract is the update-notices section of
`docs/reference/mcp-contracts.md`; the installation guide links to it.
