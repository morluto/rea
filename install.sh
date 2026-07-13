#!/bin/bash
set -euo pipefail

PACKAGE="rea-agents"
REPOSITORY="morluto/rea"
version="${REA_VERSION:-}"
dry_run=false
start_setup=true
verbose=false

fail() {
  printf 'REA installation failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version VERSION] [--dry-run] [--no-setup] [--no-prompt] [--verbose]

Installs only the REA CLI. Run `rea setup` separately to configure Hopper and coding agents.
EOF
}

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || fail "--version requires a value."
      version="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --no-setup|--no-prompt)
      start_setup=false
      shift
      ;;
    --verbose)
      verbose=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

if [[ "$verbose" == true ]]; then
  set -x
fi

platform="$(uname -s)"
[[ "$platform" == "Darwin" || "$platform" == "Linux" ]] || fail "REA supports macOS and selected 64-bit Linux distributions."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v node >/dev/null 2>&1 || fail "Node.js 22.19+ or 24.11+ is required; install it from https://nodejs.org and retry."
command -v npm >/dev/null 2>&1 || fail "npm is required; install it with Node.js and retry."

node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
IFS=. read -r node_major node_minor _node_patch <<<"$node_version"
[[ "$node_major" =~ ^[0-9]+$ && "$node_minor" =~ ^[0-9]+$ ]] || fail "could not determine the active Node.js version."
if ! ((node_major == 22 && node_minor >= 19 || node_major >= 24)); then
  fail "Node.js $node_version is unsupported; use Node.js 22.19+ or 24.11+."
fi
if ((node_major == 24 && node_minor < 11)); then
  fail "Node.js $node_version is unsupported; use Node.js 24.11 or newer."
fi

if [[ -n "$version" ]]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "version must be an exact semantic version."
else
  release_json="$(curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPOSITORY/releases/latest")" || fail "could not resolve the latest GitHub release."
  tag="$(printf '%s' "$release_json" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s).tag_name;if(typeof v!=="string")process.exit(1);process.stdout.write(v)})')" || fail "GitHub returned malformed release metadata."
  [[ "$tag" =~ ^rea-agents-([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]] || fail "latest release tag is not a valid rea-agents release."
  version="${BASH_REMATCH[1]}"
fi

prefix_args=()
if [[ "$platform" == "Linux" ]]; then
  prefix_args=(--prefix "$HOME/.local")
  install_bin="$HOME/.local/bin/rea"
else
  npm_prefix="$(npm prefix --global)" || fail "could not determine the npm global prefix."
  install_bin="$npm_prefix/bin/rea"
fi

printf 'REA install plan\n'
printf '  Version: %s\n' "$version"
printf '  Runtime: Node.js %s\n' "$node_version"
printf '  Command: npm install --global %s@%s\n' "$PACKAGE" "$version"
printf '  Binary:  %s\n' "$install_bin"
printf '  Setup:   %s\n' "$([[ "$start_setup" == true ]] && printf 'start when a terminal is available' || printf 'skipped')"

if [[ "$dry_run" == true ]]; then
  printf 'Dry run complete; no changes made.\n'
  exit 0
fi

printf 'Installing %s@%s...\n' "$PACKAGE" "$version"
npm install --global "${prefix_args[@]}" "$PACKAGE@$version" || fail "npm package installation failed."
[[ -x "$install_bin" ]] || fail "the rea command was not installed at $install_bin."
installed_version="$("$install_bin" --version 2>/dev/null | tr -d '[:space:]')" || fail "could not read the installed REA version."
[[ "$installed_version" == "$version" ]] || fail "installed version $installed_version does not match $version."

printf 'REA %s is installed.\n' "$version"
if [[ "$start_setup" == true && -r /dev/tty && -w /dev/tty && -t 1 ]]; then
  printf 'Starting REA setup...\n'
  "$install_bin" setup </dev/tty >/dev/tty
else
  printf 'Run %s setup to configure Hopper and coding agents.\n' "$install_bin"
fi
