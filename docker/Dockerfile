# REA in a Linux container: the rea-agents package on the official Node image.
# Ghidra, a JDK, the JADX engine and browsers are supplied by the caller through
# mounts and environment variables; see docs/getting-started/docker.md.
FROM node:24-bookworm-slim

# procps provides the ps that REA's Linux process supervision requires.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*

# x-release-please-start-version
RUN npm install -g rea-agents@6.8.0
# x-release-please-end

RUN useradd -m rea
USER rea
WORKDIR /targets
ENTRYPOINT ["rea"]
CMD ["mcp"]
