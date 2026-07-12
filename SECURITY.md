# Security Policy

## Supported versions

Security fixes are provided for the latest published version of REA. Upgrade to the latest release before reporting a problem that may already have been resolved.

## Reporting a vulnerability

Do not disclose vulnerabilities, proof-of-concept exploits, credentials, private binaries, or Hopper documents in a public issue.

Use **Report a vulnerability** in the repository's **Security** tab to submit the report privately. Do not open a public issue to request a private contact channel.

Include the affected REA version, operating system/distribution, Hopper version, impact, reproduction conditions, and any suggested mitigation in the private report. Remove credentials, proprietary binaries, Hopper documents, socket capability tokens, and unrelated local paths from logs or examples.

The maintainer will acknowledge the report, assess its scope, and coordinate remediation and disclosure timing with the reporter. Please allow time for Hopper-dependent behavior to be reproduced safely.

## Security boundary

REA authenticates each local bridge session with a random capability token and a current-user Unix socket. This is not a sandbox and does not protect against malicious processes already running as the same operating-system user. Opening an untrusted binary delegates parsing and analysis to Hopper with that user's permissions.

On Linux, REA accepts release metadata only from Hopper's HTTPS endpoint, restricts package URLs to Hopper's public download origin, bounds the package size, and compares the downloaded bytes with Hopper's published checksum before requesting installation. The published SHA-1 value is a corruption check, not a modern package signature; HTTPS origin validation remains part of the trust boundary. Dependency installation is delegated without shell evaluation to `apt-get`, `dnf`, or `pacman`, directly as root or through `pkexec`. REA never invokes `sudo`.
