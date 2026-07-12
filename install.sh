#!/bin/bash
set -euo pipefail

PACKAGE="rea-agents"
REPOSITORY="morluto/rea"
NODE_FORMULA="node@24"
NODE_VERSION="24.18.0"
temporary_directory=""
node_destination=""
node_stage=""
node_backup=""
node_version=""

cleanup() {
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    rm -rf -- "$temporary_directory"
  fi
  if [[ -n "$node_stage" && -e "$node_stage" ]]; then
    rm -rf -- "$node_stage"
  fi
  if [[ -n "$node_backup" && -e "$node_backup" && ! -e "$node_destination" ]]; then
    mv -- "$node_backup" "$node_destination"
  fi
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'REA installation failed: %s\n' "$1" >&2
  exit 1
}

version_at_least() {
  local actual="$1" required_major="$2" required_minor="$3"
  local major minor
  major="${actual%%.*}"
  minor="${actual#*.}"
  minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  ((major > required_major || (major == required_major && minor >= required_minor)))
}

platform="$(uname -s)"
if [[ "$platform" == "Darwin" ]]; then
  macos_version="$(sw_vers -productVersion 2>/dev/null)" || fail "could not determine the macOS version."
  macos_major="${macos_version%%.*}"
  [[ "$macos_major" =~ ^[0-9]+$ && "$macos_major" -ge 12 ]] || fail "macOS 12 or newer is required."
elif [[ "$platform" == "Linux" ]]; then
  [[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "aarch64" ]] || fail "64-bit x86 or ARM Linux is required."
  [[ -r /etc/os-release ]] || fail "could not identify the Linux distribution."
  linux_id="$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')"
  linux_version="$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')"
  case "$linux_id" in
    ubuntu) [[ "${linux_version%%.*}" -ge 24 ]] || fail "Ubuntu 24.04 or newer is required." ;;
    fedora) [[ "${linux_version%%.*}" -ge 41 ]] || fail "Fedora 41 or newer is required." ;;
    arch) ;;
    *) fail "supported Linux distributions are Ubuntu 24.04+, Fedora 41+, and Arch Linux." ;;
  esac
else
  fail "REA supports macOS and selected 64-bit Linux distributions."
fi
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || fail "shasum or sha256sum is required."

if [[ "$platform" == "Darwin" ]] && ! command -v brew >/dev/null 2>&1; then
  printf 'Installing Homebrew prerequisite...\n'
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew installation did not complete."
  if [[ -x /opt/homebrew/bin/brew ]]; then
    PATH="/opt/homebrew/bin:$PATH"
  elif [[ -x /usr/local/bin/brew ]]; then
    PATH="/usr/local/bin:$PATH"
  fi
fi
if [[ "$platform" == "Darwin" ]]; then
  command -v brew >/dev/null 2>&1 || fail "Homebrew is not available after installation."
fi

node_compatible=false
if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
fi
if version_at_least "$node_version" 24 18 && [[ "$node_version" =~ ^24\. ]]; then
  node_compatible=true
fi
if [[ "$node_compatible" != true ]]; then
  if [[ "$platform" == "Darwin" ]]; then
    brew install "$NODE_FORMULA" || fail "Node.js 24 installation failed."
    node_prefix="$(brew --prefix "$NODE_FORMULA")" || fail "could not locate Node.js 24."
    PATH="$node_prefix/bin:$PATH"
  else
    machine="$(uname -m)"
    node_arch="$([[ "$machine" == "x86_64" ]] && printf 'x64' || printf 'arm64')"
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
    node_base="https://nodejs.org/dist/v${NODE_VERSION}"
    temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/rea-install.XXXXXX")" || fail "could not create a temporary directory."
    curl -fsSL "$node_base/$node_archive" -o "$temporary_directory/$node_archive" || fail "Node.js download failed."
    curl -fsSL "$node_base/SHASUMS256.txt" -o "$temporary_directory/SHASUMS256.txt" || fail "Node.js checksum download failed."
    expected_checksum="$(awk -v archive="$node_archive" '$2 == archive { print $1 }' "$temporary_directory/SHASUMS256.txt")"
    [[ "$expected_checksum" =~ ^[a-f0-9]{64}$ ]] || fail "Node.js checksum metadata was malformed."
    if command -v shasum >/dev/null 2>&1; then
      actual_checksum="$(shasum -a 256 "$temporary_directory/$node_archive" | awk '{ print $1 }')"
    else
      actual_checksum="$(sha256sum "$temporary_directory/$node_archive" | awk '{ print $1 }')"
    fi
    [[ "$actual_checksum" == "$expected_checksum" ]] || fail "Node.js checksum verification failed."
    node_destination="$HOME/.local/share/rea/node"
    node_stage="$HOME/.local/share/rea/node.new.$$"
    node_backup="$HOME/.local/share/rea/node.backup.$$"
    [[ ! -L "$node_destination" ]] || fail "refusing to replace a symlinked Node.js installation."
    mkdir -p "$HOME/.local/share/rea"
    rm -rf -- "$node_stage" "$node_backup"
    mkdir "$node_stage"
    tar -xJf "$temporary_directory/$node_archive" --strip-components=1 -C "$node_stage" || fail "Node.js extraction failed."
    if [[ -e "$node_destination" ]]; then
      mv -- "$node_destination" "$node_backup"
    fi
    if ! mv -- "$node_stage" "$node_destination"; then
      [[ ! -e "$node_backup" ]] || mv -- "$node_backup" "$node_destination"
      fail "Node.js installation replacement failed."
    fi
    node_stage=""
    rm -rf -- "$node_backup"
    node_backup=""
    PATH="$node_destination/bin:$PATH"
  fi
fi
node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
if ! command -v node >/dev/null 2>&1 || ! version_at_least "$node_version" 24 18 || [[ ! "$node_version" =~ ^24\. ]]; then
  fail "Node.js 24.18 or newer is not active on PATH."
fi
command -v npm >/dev/null 2>&1 || fail "npm is missing from the Node.js installation."
npm_version="$(npm --version)"
if [[ ! "$npm_version" =~ ^11\. ]] || ! version_at_least "$npm_version" 11 16; then
  if [[ "$platform" == "Linux" ]]; then
    npm install --global --prefix "$HOME/.local" npm@11 || fail "npm 11 installation failed."
  else
    npm install --global npm@11 || fail "npm 11 installation failed."
  fi
fi
npm_version="$(npm --version)"
if [[ ! "$npm_version" =~ ^11\. ]] || ! version_at_least "$npm_version" 11 16; then
  fail "npm 11.16 or newer is not active on PATH."
fi
if [[ -n "$temporary_directory" ]]; then
  rm -rf -- "$temporary_directory"
  temporary_directory=""
fi

if [[ -n "${REA_VERSION:-}" ]]; then
  version="$REA_VERSION"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "REA_VERSION must be an exact semantic version."
else
  release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPOSITORY/releases/latest")" || fail "could not resolve the latest GitHub release."
  tag="$(printf '%s' "$release_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s).tag_name;if(typeof v!=="string")process.exit(1);process.stdout.write(v)})')" || fail "GitHub returned malformed release metadata."
  [[ "$tag" =~ ^rea-agents-([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]] || fail "latest release tag is not a valid rea-agents release."
  version="${BASH_REMATCH[1]}"
fi

printf 'Installing %s@%s...\n' "$PACKAGE" "$version"
if [[ "$platform" == "Linux" ]]; then
  mkdir -p "$HOME/.local/bin"
  PATH="$HOME/.local/bin:$PATH"
  npm install --global --prefix "$HOME/.local" "$PACKAGE@$version" || fail "npm package installation failed."
else
  npm install --global "$PACKAGE@$version" || fail "npm package installation failed."
fi
command -v rea >/dev/null 2>&1 || fail "the rea command is not available after installation."
installed_version="$(rea --version 2>/dev/null | tr -d '[:space:]')" || fail "could not read the installed REA version."
[[ "$installed_version" == "$version" ]] || fail "installed version $installed_version does not match $version."

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/rea-install.XXXXXX")" || fail "could not create a temporary directory."
setup_output="$temporary_directory/setup.json"
doctor_output="$temporary_directory/doctor.json"
rea setup --yes --json >"$setup_output" || fail "REA setup command failed."
rea doctor --json >"$doctor_output" || fail "REA doctor command failed."
result="$(node - "$setup_output" "$doctor_output" <<'NODE'
const fs = require("node:fs");
const [setupPath, doctorPath] = process.argv.slice(2);
try {
  const setup = JSON.parse(fs.readFileSync(setupPath, "utf8"));
  const doctor = JSON.parse(fs.readFileSync(doctorPath, "utf8"));
  if (!Array.isArray(doctor.checks) || typeof doctor.healthy !== "boolean") process.exit(2);
  if (setup.status !== "ready" && setup.status !== "needs_human") process.exit(2);
  const activation = setup.actions.includes("installed_hopper");
  if (!doctor.healthy && !activation) process.exit(3);
  process.stdout.write(activation ? "activation" : "ready");
} catch { process.exit(2); }
NODE
)" || fail "setup or doctor reported an unhealthy required component or malformed output."

if [[ "$result" == "activation" ]]; then
  printf 'REA %s is installed and coding agents are configured.\n' "$version"
  printf 'One user action remains: open Hopper, complete its activation, then run: rea doctor --json\n'
else
  printf 'REA %s is installed and ready. Run rea doctor --json at any time.\n' "$version"
fi
if [[ "$platform" == "Linux" ]]; then
  printf 'Add %s to PATH to run rea from future shells.\n' "$HOME/.local/bin"
fi
