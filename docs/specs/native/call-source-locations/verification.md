# Historical verification

The records below describe earlier revisions, before the final caller-frame
assertions, marker-derived line expectations, forced compiler timeout termination,
and large Unicode source-location budget coverage. They do not validate the
current revision. Those final changes were reviewed from source only; tests and
automated checks were not run at the user’s explicit request.

Host: macOS ARM64. Compiler: caller-installed Free Pascal 3.2.2, Darwin AArch64.
Debugger: LLDB 2103.0.34.103 from Command Line Tools.

- Python producer/budget/output tests: 10 passed.
- Focused native provider, retained-journal and MCP tests: 18 passed.
- Real Pascal CLI and stdio MCP: three expected calls, integer register values
  0/1/2, source path and positive line attribution, successful target exit.
- Repository static checks: six tasks and architecture guards passed.
- Test discovery: all 982 test files discovered exactly once.

The complete native-call verifier did not pass. One run reported exited instead
of event-limit for capped overlapping breakpoints. Another reported unavailable
launch start identity in a later capped scenario. Investigation:
https://github.com/morluto/rea/issues/2397. These results have not yet been isolated
on unchanged upstream. The source-coordinate PR was draft at that historical checkpoint.

The first real native scenario and CLI/MCP source-coordinate comparisons completed
before those broader failures. The Pascal lane verifies bounded native call
observation; it does not establish typed Pascal local values, source breakpoints,
interactive stepping, Delphi compatibility or a GDB provider.

## Unmeasured costs and outstanding execution

Repeated source paths expand event, caller-frame and breakpoint-location payloads.
Equivalent before/after completed workflows have not been measured for agent tokens,
elapsed time, CPU time or peak process-family memory, for either cold or warm runs.
No byte count is presented as a token or performance measurement. Representative
measurements remain outstanding before integration; they were not executed under
the current instruction to skip tests and provider workloads.

The current caller-frame equality checks, marker-derived source lines, forced
compiler timeout termination and Unicode source-path budget case remain unverified
by execution. Earlier Pascal CLI/MCP observations establish only the historical
coverage described above.
