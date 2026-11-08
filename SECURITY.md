# Security Policy

## Supported versions

Security fixes are provided for the latest published version of REA. Upgrade to the latest release before reporting a problem that may already have been resolved.

## Security boundary

REA is a local reverse-engineering and automation tool. CLI and MCP use the
same application workflows and run with the host process's permissions.
REA is not a general-purpose sandbox or a multi-tenant authorization service.

### Threat model

- **Trusted authority:** the operating-system account running REA, the caller
  or agent host that selects operations, and configured analysis providers,
  their executables and extensions, and service endpoints. An MCP client can
  invoke the operations exposed to it; its host must enforce the user's tool
  permissions and approvals.
- **Untrusted data:** target binaries, archives, source files, project contents,
  captures, web pages and returned target content can be malicious. Selecting
  an input for static inspection does not authorize commands embedded in that
  input. Agents must treat target text and Evidence as data rather
  than instructions granting additional authority.
- **Operation-specific effects:** static inspection parses target data and may
  launch an analysis engine. Runtime, debugger, instrumentation, browser,
  desktop and environment workflows can deliberately execute code, attach to
  processes, make network requests, write files or interact with applications
  and devices. Review the selected operation's effects and limitations; static
  inspection does not authorize launching or interacting with the target
  application. See
  [runtime and network responsibilities](DISCLAIMER.md#runtime-network-and-device-operations).

### Intended security properties

Static JavaScript and .NET inspection do not run the target application.
Unexpected execution of input code through a data-only analysis path is a
security concern. Analysis engines themselves are executable software trusted
with the host account's permissions; parsing an input in an external engine
does not isolate that engine from the host.

REA authenticates its managed Hopper and Ghidra bridges with per-session random
capability tokens transferred through private session files, rather than
process arguments or environment variables. POSIX uses current-user Unix
sockets. Windows Ghidra uses authenticated loopback TCP and a private NTFS
runtime whose DACL admits only the current user and SYSTEM. These controls
protect the managed session boundary, not every external provider or debugger
endpoint. See [Windows Ghidra transport and lifecycle](docs/providers/windows-ghidra-p0.md#private-runtime-transport-and-lifecycle).

Provider ownership and mutation rules remain specific to each workflow:

- Ghidra's working projects are temporary and owned by REA. Opt-in
  [checkpoints](docs/getting-started/installation.md#automatically-checkpoint-an-owned-ghidra-program)
  retain REA-owned Program state. A
  [caller-selected existing project](docs/getting-started/installation.md#reuse-an-existing-ghidra-project)
  is fingerprinted and copied into an owned runtime for read-only processing;
  Ghidra does not open or save the original database through that workflow.
- [IDA analysis](docs/providers/ida-provider.md) is read-only. An attached GUI
  database is never saved or closed by REA; owned headless sessions have a
  separate lifecycle.
- Cleanup must stay within resources REA owns. Failed or unverified cleanup
  can retain a workspace or session for retry; closing a session
  does not imply that every investigation artifact has been erased.

`rea setup` shows planned configuration and installation changes and requires
approval before applying them. Ghidra, Java and IDA are user-managed. Approved
Linux Hopper installation authenticates the package's detached PGP signature
against the pinned publisher identity and checks the signed launcher against
the selected release's digest. The release feed's display version is separate
from that authenticated identity. See [installation and publisher verification](docs/getting-started/installation.md#hopper).

### Limits and caller responsibilities

- **Host isolation:** private runtimes and capability tokens do not protect
  against malicious software already running as the same operating-system
  user, or a compromised trusted client or provider. Use an appropriately
  isolated account, VM or restricted environment when handling hostile targets.
- **Resource bounds:** timeouts, cancellation, streaming and size limits are
  operation-specific. They are not a universal CPU, memory, disk or wall-time
  limit on every target and third-party tool. Enforce hard host resource limits
  externally when needed. Failures of a documented boundary or cancellation
  control still warrant investigation.
- **Data and network exposure:** Evidence, caches, checkpoints, exports and
  captures can retain private target data, paths, URLs and memory contents.
  Local execution does not make these outputs safe to publish. Requested
  network operations, agent hosts and provider features such as
  [IDA Free's cloud decompiler](docs/providers/ida-provider.md) can communicate
  outside the host. Review their data handling and secure any exposed endpoint.
- **Interpretation:** analysis, reconstruction and generated environments can
  be incomplete or incorrect. Identity checks, signatures and successful
  analysis do not establish that a target, provider or generated program is
  safe to execute. Review the Evidence and proposed actions before relying on
  them.

### Vulnerability scope

Please report suspected violations of these boundaries privately. Examples
include unintended code execution during data-only inspection, escaping a
documented extraction/output boundary, bypassing bridge authentication or
target/session identity checks, unauthorized effects on an unrelated resource,
and disclosure of transport credentials or explicitly marked sensitive values.
An attacker-triggered bypass of a documented resource or cancellation control
can also be security-relevant without code execution.

Incorrect analysis, unsupported formats, crashes, hangs and high resource use
without a security-boundary impact are generally ordinary bug reports. Effects
explicitly requested through an execution or interaction workflow are not by
themselves a vulnerability. A dependency advisory needs its actual REA exposure
assessed; a complete exploit or diagnosis is not required to report a concern.
If you are unsure whether a boundary is affected, use the private channel below.

## Reporting a vulnerability

Do not disclose vulnerabilities, proof-of-concept exploits, credentials,
private binaries, Hopper documents, or private Ghidra projects in a public
issue.

Use **Report a vulnerability** in the repository's **Security** tab as the preferred way to submit the report privately. If GitHub private reporting is unavailable to you, email [morluto@outlook.com](mailto:morluto@outlook.com). Do not open a public issue to request a private contact channel.

Include the affected REA version, operating system/distribution, selected
provider and version, impact, reproduction conditions, and any suggested
mitigation in the private report. Remove credentials, proprietary binaries,
Hopper documents, Ghidra project contents, socket capability tokens, and
unrelated local paths from logs or examples.

The maintainer will acknowledge the report, assess its scope, and coordinate
remediation and disclosure timing with the reporter. Please allow time for
provider-dependent behavior to be reproduced safely.
