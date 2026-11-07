# Docker

[`docker/Dockerfile`](https://github.com/morluto/rea/blob/main/docker/Dockerfile)
builds a Linux x64 image containing only REA (`rea-agents`) on the official
Node.js image. Use it to keep untrusted targets away from your host, or to use
the Linux providers from a Windows or macOS host through Docker Desktop.

The image does not include Ghidra, a JDK, the JADX engine or a browser. As
with a host installation, you supply those yourself and point REA at them with
the usual environment variables; see [Supply the tools](#supply-the-tools).

The container is an isolation boundary for the target files you mount, not a
sandbox for anything those targets contact. Browser pages still reach the
network, and anything you mount writable can be changed.

## Build

From a checkout of this repository:

```bash
docker build --platform linux/amd64 -t rea docker/
```

`--platform linux/amd64` keeps the supported x64 image on ARM64 hosts such as
Apple silicon, where Docker runs it under emulation. That combination has not
been verified.

The build downloads the official `node` base image and the `rea-agents` npm
package. The image runs as an unprivileged `rea` user, with `/targets` as its
working directory.

## Supply the tools

Provide Linux x64 builds of the tools a workflow needs, and mount them
read-only:

| Tool                                      | Variable             | Guide                                   |
| ----------------------------------------- | -------------------- | --------------------------------------- |
| Ghidra 12.1.x                             | `GHIDRA_INSTALL_DIR` | [Installation](installation.md)         |
| JDK 21 (64-bit, full) for Ghidra and JADX | `JAVA_HOME`          | [Installation](installation.md)         |
| `jadx-headless-mcp` 0.7.1 JAR             | `REA_JADX_MCP_JAR`   | [Android analysis](android-analysis.md) |

On Windows and macOS hosts, keep these Linux trees in a Docker volume rather
than a host folder: a JDK contains symbolic links that a Windows bind mount
cannot reproduce. For example, with a volume named `rea-tools` that holds
`ghidra/`, `jdk/` and `jadx/`:

```bash
docker run --rm \
  -v rea-tools:/opt/tools:ro \
  -e GHIDRA_INSTALL_DIR=/opt/tools/ghidra \
  -e JAVA_HOME=/opt/tools/jdk \
  -e REA_JADX_MCP_JAR=/opt/tools/jadx/jadx-headless-mcp-0.7.1-all.jar \
  rea doctor --provider ghidra
```

Check the JADX installation the same way with `doctor --provider jadx`. It
validates the JADX JAR and the Java runtime REA would launch, not whether the
JADX heap is large enough for a given APK (see [Memory](#memory)). To test
Android analysis end to end, run an [Android command](android-analysis.md)
against an APK.

The examples below shorten these mounts and variables to `<tools>`.

## Register with an agent

The image's default command is `rea mcp`. Docker must keep stdin open, so pass
`-i`. For Claude Code:

```bash
claude mcp add --scope local rea -- docker run -i --rm --memory 3g -e GHIDRA_HEADLESS_MAXMEM=2G <tools> -v /absolute/host/targets:/targets:ro rea
```

Other clients use the same command and arguments in their
[manual MCP registration](installation.md#mcp-registry). On Windows, write the
host path with forward slashes, for example `C:/work/targets:/targets:ro`.

With `--rm`, each agent session starts a new container, and Docker removes it
when the session ends. When no session is running, Docker Desktop lists the
`rea` image but no container.

## Targets and paths

REA sees only the paths that exist inside the container. Mount the directory
holding your targets, read-only where possible, and give the agent container
paths such as `/targets/app.apk`, not host paths.

Ghidra imports targets into a temporary project, so Ghidra analysis works on a
read-only mount. Commands that export files need a writable directory: mount a
separate output directory for those, and leave the targets read-only.

## Memory

Ghidra's JVM can take a large share of the Docker VM's memory. Set a container
limit and a smaller Ghidra heap, as in the registration above:

```bash
docker run --rm --memory 3g -e GHIDRA_HEADLESS_MAXMEM=2G <tools> -v /absolute/host/targets:/targets:ro rea function /targets/program main --provider ghidra
```

See [installation](installation.md) for the other Ghidra memory settings.

JADX gets no heap setting from REA. Inside a container, Java's default heap is
a quarter of the container limit, so `--memory 3g` leaves JADX about 768 MiB.
That is enough for small APKs. A large APK can then fail during load with
`load failed: Java heap space`; a 74 MB APK with about 28,000 classes did. Raise
the container limit and set the JADX heap explicitly:

```bash
docker run --rm --memory 6g -e REA_JADX_HEAP_MIB=4096 <tools> -v /absolute/host/targets:/targets:ro rea inspect-android-package /targets/app.apk
```

Keep the heap below the container limit, because the JVM also uses native
memory. See [Android analysis](android-analysis.md) for `REA_JADX_HEAP_MIB` and
the other JADX settings.

## Browsers

The image contains no browser and does not change browser sandbox settings.

[CDP observation](browser-observation.md) attaches to a browser that is
already running with a loopback debugging port; REA does not launch it. Run a
headless browser of your choice in its own container, and give REA's container
the same network namespace so that the browser's port is loopback for REA:

```bash
docker run -d --name rea-browser <your-headless-browser-image>
docker run -i --rm --network container:rea-browser <tools> -v /absolute/host/targets:/targets:ro rea
```

The agent then uses `http://127.0.0.1:9222` (or the port your browser image
exposes) as the CDP endpoint. Stop the browser with `docker rm -f rea-browser`
when the investigation is complete. The browser container's own isolation,
including its sandbox, is that image's configuration.

Workflows where REA launches the browser itself, such as
[browser scenarios](browser-scenario-contract.md), need a browser executable
and its system libraries inside REA's container. Build a derived image that
adds them, and set `REA_BROWSER_EXECUTABLE`. Chromium's sandbox needs user
namespaces, which Docker's default seccomp profile blocks, so Chromium then
exits with `No usable sandbox!`. To run it without its sandbox, opt in for that
run only:

```bash
docker run --rm -e REA_BROWSER_NO_SANDBOX=true -e REA_BROWSER_EXECUTABLE=/path/in/image/chromium … your-derived-image …
```

Inspect only sites you are prepared to load in an unsandboxed browser inside
that container.

## Limits

- The image targets Linux x64. Linux ARM64 also needs Ghidra's native
  decompiler built for that platform; see [installation](installation.md).
- Hopper, IDA and JEB are not included. Native analysis in the image uses
  the Ghidra installation you supply.
- Apple tooling and other host-specific providers
  remain unavailable in a Linux container. Windows and macOS binaries can still
  be analysed statically with Ghidra.
- Firmware, packet and signal tools (Binwalk, Unblob, TShark, sigrok) and
  util-linux `prlimit`, which those integrations require, are not installed.
  Add them to a derived image when you need them.

## Update

The Dockerfile pins the `rea-agents` release it was published with. Pull the
repository and rebuild with `docker build --pull --platform linux/amd64 -t rea docker/` to pick up
a newer release and base image. Update the tools you supply separately.
