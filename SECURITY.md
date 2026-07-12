# Security Policy

## Supported versions

Security fixes are provided for the latest published version of REA. Upgrade to the latest release before reporting a problem that may already have been resolved.

## Reporting a vulnerability

Do not disclose vulnerabilities, proof-of-concept exploits, credentials, private binaries, or Hopper documents in a public issue.

If private vulnerability reporting is available in the repository's **Security** tab, use **Report a vulnerability**. Otherwise, open a minimal issue asking the maintainer to establish a private contact channel; include no sensitive technical details in that issue.

Include the affected REA version, macOS and Hopper versions, impact, reproduction conditions, and any suggested mitigation in the private report. Remove credentials, proprietary binaries, Hopper documents, socket capability tokens, and unrelated local paths from logs or examples.

The maintainer will acknowledge the report, assess its scope, and coordinate remediation and disclosure timing with the reporter. Please allow time for Hopper-dependent behavior to be reproduced safely.

## Security boundary

REA authenticates each local bridge session with a random capability token and a current-user Unix socket. This is not a sandbox and does not protect against malicious processes already running as the same macOS user. Opening an untrusted binary delegates parsing and analysis to Hopper with that user's permissions.
