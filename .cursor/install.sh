#!/usr/bin/env bash
# Cloud Agent bootstrap for morluto/rea.
# Installs the Node.js toolchain pinned in .nvmrc (and the npm that ships
# with it) under /usr/local, then refreshes locked dependencies.
# Idempotent: a second run skips the download when that Node is already present.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "REA Cloud Agent install supports linux x86_64 only (got $(uname -m))." >&2
  exit 1
fi

node_version="$(tr -d '[:space:]' < .nvmrc)"
if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing to install Node: .nvmrc must be an exact x.y.z version, got '${node_version}'." >&2
  exit 1
fi

prefix="/usr/local/lib/nodejs"

install_pinned_node() {
  if [[ -x "${prefix}/bin/node" ]] && [[ "$("${prefix}/bin/node" -v)" == "v${node_version}" ]]; then
    return
  fi
  local tmp tarball
  tmp="$(mktemp -d)"
  tarball="node-v${node_version}-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/${tarball}" -o "${tmp}/${tarball}"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
  (
    cd "$tmp"
    grep " ${tarball}$" SHASUMS256.txt | sha256sum -c -
  )
  sudo mkdir -p "$prefix"
  sudo tar -xJf "${tmp}/${tarball}" -C "$prefix" --strip-components=1
  rm -rf "$tmp"
}

link_toolchain() {
  local dest="$1"
  local bin
  for bin in node npm npx; do
    sudo ln -sfn "${prefix}/bin/${bin}" "${dest}/${bin}"
  done
  if [[ -e "${prefix}/bin/corepack" ]]; then
    sudo ln -sfn "${prefix}/bin/corepack" "${dest}/corepack"
  fi
}

# Cursor Cloud can place an older Node (/exec-daemon/node) ahead of
# /usr/local/bin. Link the pinned binaries into the first earlier PATH
# directory we are allowed to write, and skip /exec-daemon itself.
expose_ahead_of_runtime_node() {
  local dir
  local -a dirs=()
  IFS=':' read -r -a dirs <<< "$PATH"
  for dir in "${dirs[@]}"; do
    [[ -n "$dir" ]] || continue
    [[ "$dir" == "/usr/local/bin" ]] && break
    [[ "$dir" == /exec-daemon || "$dir" == /exec-daemon/* ]] && continue
    if [[ -d "$dir" ]] && { [[ -w "$dir" ]] || sudo -n test -w "$dir"; }; then
      link_toolchain "$dir"
      return
    fi
  done
}

install_pinned_node
link_toolchain /usr/local/bin

sudo tee /etc/profile.d/pinned-node.sh >/dev/null <<'EOF'
export PATH="/usr/local/bin:${PATH}"
EOF
sudo chmod 644 /etc/profile.d/pinned-node.sh

expose_ahead_of_runtime_node

export PATH="/usr/local/bin:${PATH}"
hash -r || true

if [[ "$(node -v)" != "v${node_version}" ]]; then
  echo "node resolved to $(command -v node) ($(node -v)); expected v${node_version}." >&2
  exit 1
fi

npm ci
