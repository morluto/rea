#!/usr/bin/env bash
# Cloud Agent bootstrap for morluto/rea.
# Installs the Node.js toolchain pinned in .nvmrc under /usr/local/lib/nodejs,
# puts it on PATH ahead of Cursor's /exec-daemon runtime for later shells, then
# installs the npm version in package.json#packageManager and runs npm ci.
#
# The live prefix is replaced only after node, npm, npx, and the npm library
# all check out in a staging directory. Later shells do not inherit this
# process's exports: login shells read /etc/profile.d, and non-login shells
# read the bashrc block written below. The version check uses those files
# with the PATH this process started with.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

prefix="/usr/local/lib/nodejs"
shim_dir="/usr/local/lib/nodejs-shims"
profile_file="/etc/profile.d/pinned-node.sh"
bashrc_file="${HOME}/.bashrc"
marker_begin="# BEGIN rea-cloud-node"
marker_end="# END rea-cloud-node"

# Captured before this process prepends anything. Later shells start here.
original_path="${PATH-}"

work_dir=""
stage_dir=""

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    rm -rf "$work_dir"
  fi
  if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
    as_root rm -rf "$stage_dir" || true
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "REA Cloud Agent install supports Linux x86_64 only (got $(uname -s) $(uname -m))." >&2
  exit 1
fi

if [[ ! -f .nvmrc ]]; then
  echo "Missing .nvmrc in ${repo_root}." >&2
  exit 1
fi

node_version="$(tr -d '[:space:]' < .nvmrc)"
if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing to install Node: .nvmrc must be an exact x.y.z version, got '${node_version}'." >&2
  exit 1
fi

if [[ ! -f package.json ]]; then
  echo "Missing package.json in ${repo_root}." >&2
  exit 1
fi

read_package_manager_spec() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json; print(json.load(open("package.json"))["packageManager"], end="")'
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("./package.json").packageManager)'
  else
    echo "Reading package.json#packageManager requires python3 or node." >&2
    exit 1
  fi
}

package_manager_spec="$(read_package_manager_spec)"
if [[ "$package_manager_spec" != npm@* || "$package_manager_spec" == *$'\n'* ]]; then
  echo "Refusing to install packageManager '${package_manager_spec}'; expected npm@x.y.z." >&2
  exit 1
fi
npm_version="${package_manager_spec#npm@}"
npm_version="${npm_version%%+*}"
if [[ ! "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Refusing to install packageManager '${package_manager_spec}'." >&2
  exit 1
fi

# node -v alone is not a complete install: a retry must see npm, npx, and the
# npm library, and those commands must run under this prefix's node.
toolchain_is_complete() {
  local root="$1"
  local node_bin="${root}/bin/node"
  local npm_bin="${root}/bin/npm"
  local npx_bin="${root}/bin/npx"
  local npm_lib="${root}/lib/node_modules/npm/package.json"
  [[ -x "$node_bin" && -x "$npm_bin" && -x "$npx_bin" && -f "$npm_lib" ]] || return 1
  [[ "$("$node_bin" -v 2>/dev/null)" == "v${node_version}" ]] || return 1
  PATH="${root}/bin:${PATH-}" "$npm_bin" -v >/dev/null 2>&1 || return 1
  PATH="${root}/bin:${PATH-}" "$npx_bin" -v >/dev/null 2>&1 || return 1
}

publish_stage() {
  local staged="$1"
  local backup="${prefix}.previous"
  as_root rm -rf "$backup"
  if [[ -d "$prefix" ]]; then
    as_root mv "$prefix" "$backup"
  fi
  if ! as_root mv "$staged" "$prefix"; then
    if [[ -d "$backup" && ! -d "$prefix" ]]; then
      as_root mv "$backup" "$prefix" || true
    fi
    echo "Could not publish the staged Node ${node_version} toolchain." >&2
    exit 1
  fi
  stage_dir=""
  as_root rm -rf "$backup"
  as_root chmod 755 "$prefix"
}

install_pinned_node() {
  if toolchain_is_complete "$prefix"; then
    return
  fi

  local tarball parent
  tarball="node-v${node_version}-linux-x64.tar.xz"
  work_dir="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/${tarball}" -o "${work_dir}/${tarball}"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "${work_dir}/SHASUMS256.txt"
  (
    cd "$work_dir"
    awk -v file="$tarball" '
      $2 == file { print $1 "  " file; found = 1 }
      END { if (!found) exit 1 }
    ' SHASUMS256.txt | sha256sum -c -
  )

  parent="$(dirname "$prefix")"
  as_root mkdir -p "$parent"
  stage_dir="$(as_root mktemp -d "${parent}/nodejs.staging.XXXXXX")"
  as_root tar -xJf "${work_dir}/${tarball}" -C "$stage_dir" --strip-components=1
  as_root chmod 755 "$stage_dir"
  rm -rf "$work_dir"
  work_dir=""

  if ! toolchain_is_complete "$stage_dir"; then
    as_root rm -rf "$stage_dir"
    stage_dir=""
    echo "Staged Node ${node_version} is missing a working node, npm, npx, or npm library. The live prefix was left unchanged." >&2
    exit 1
  fi
  publish_stage "$stage_dir"
}

# Only the directory this install creates receives symlinks. A pre-existing
# node, npm, or npx anywhere else on PATH is left alone.
assert_shim_destination() {
  local name="$1"
  local dest="${shim_dir}/${name}"
  local source="${prefix}/bin/${name}"
  local target
  if [[ ! -e "$dest" && ! -L "$dest" ]]; then
    return
  fi
  if [[ -L "$dest" ]]; then
    target="$(readlink "$dest")"
    if [[ "$target" == "$source" ]]; then
      return
    fi
    echo "Refusing to replace pre-existing ${dest} -> ${target}." >&2
    exit 1
  fi
  echo "Refusing to replace pre-existing ${dest}; it is not a symlink from this install." >&2
  exit 1
}

link_shim() {
  local name="$1"
  local source="${prefix}/bin/${name}"
  assert_shim_destination "$name"
  as_root ln -sfn "$source" "${shim_dir}/${name}"
}

link_owned_shims() {
  local name
  as_root mkdir -p "$shim_dir"
  as_root chmod 755 "$shim_dir"
  for name in node npm npx; do
    if [[ ! -e "${prefix}/bin/${name}" && ! -L "${prefix}/bin/${name}" ]]; then
      echo "Pinned Node toolchain is missing bin/${name}." >&2
      exit 1
    fi
    link_shim "$name"
  done
  if [[ -e "${prefix}/bin/corepack" || -L "${prefix}/bin/corepack" ]]; then
    link_shim corepack
  fi
}

path_snippet() {
  cat <<EOF
# Keep the Node toolchain pinned in .nvmrc ahead of any older /exec-daemon runtime.
_rea_shim='${shim_dir}'
_rea_new=''
_rea_old_ifs=\$IFS
_rea_noglob=0
case \$- in
  *f*) _rea_noglob=1 ;;
esac
set -f
IFS=:
for _rea_dir in \${PATH-}; do
  if [ "\$_rea_dir" = "\$_rea_shim" ]; then
    continue
  fi
  if [ -n "\$_rea_new" ]; then
    _rea_new="\${_rea_new}:\${_rea_dir}"
  else
    _rea_new="\$_rea_dir"
  fi
done
IFS=\$_rea_old_ifs
if [ "\$_rea_noglob" -eq 0 ]; then
  set +f
fi
PATH="\${_rea_shim}\${_rea_new:+:\${_rea_new}}"
export PATH
hash -r 2>/dev/null || true
unset _rea_shim _rea_new _rea_old_ifs _rea_noglob _rea_dir
EOF
}

persist_profile() {
  local tmp
  tmp="$(mktemp)"
  path_snippet >"$tmp"
  as_root mkdir -p "$(dirname "$profile_file")"
  as_root cp "$tmp" "$profile_file"
  as_root chmod 644 "$profile_file"
  rm -f "$tmp"
}

persist_bashrc() {
  local stripped tmp
  mkdir -p "$(dirname "$bashrc_file")"
  if [[ ! -e "$bashrc_file" ]]; then
    : >"$bashrc_file"
  fi
  stripped="$(mktemp)"
  awk -v begin="$marker_begin" -v end="$marker_end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    skip != 1 { print }
  ' "$bashrc_file" >"$stripped"
  tmp="$(mktemp)"
  {
    cat "$stripped"
    printf '%s\n' "$marker_begin"
    path_snippet
    printf '%s\n' "$marker_end"
  } >"$tmp"
  mv "$tmp" "$bashrc_file"
  rm -f "$stripped"
}

shim_precedes_exec_daemon() {
  local path_value="$1"
  local dir shim_index=-1 exec_index=-1 index=0
  local -a dirs=()
  IFS=':' read -r -a dirs <<<"$path_value"
  for dir in "${dirs[@]}"; do
    if [[ "$dir" == "$shim_dir" && "$shim_index" -lt 0 ]]; then
      shim_index=$index
    fi
    if [[ "$exec_index" -lt 0 && ("$dir" == "/exec-daemon" || "$dir" == /exec-daemon/*) ]]; then
      exec_index=$index
    fi
    index=$((index + 1))
  done
  [[ "$shim_index" -ge 0 ]] || return 1
  [[ "$exec_index" -lt 0 || "$shim_index" -lt "$exec_index" ]]
}

shell_resolution() {
  local kind="$1"
  if [[ "$kind" == "bashrc" ]]; then
    # The nested script must not expand in this process.
    # shellcheck disable=SC2016
    env PATH="$original_path" REA_BASHRC="$bashrc_file" bash --noprofile --norc -c '
      set +e
      # shellcheck disable=SC1090
      . "$REA_BASHRC"
      set -eu
      printf "NODE_BIN=%s\n" "$(command -v node)"
      printf "NODE_VER=%s\n" "$(node -v)"
      printf "NPM_BIN=%s\n" "$(command -v npm)"
      printf "NPM_VER=%s\n" "$(npm -v)"
      printf "NPX_BIN=%s\n" "$(command -v npx)"
      printf "PATH=%s\n" "$PATH"
    '
  else
    # The nested script must not expand in this process.
    # shellcheck disable=SC2016
    env PATH="$original_path" REA_PROFILE="$profile_file" sh -c '
      set -eu
      # shellcheck disable=SC1090
      . "$REA_PROFILE"
      printf "NODE_BIN=%s\n" "$(command -v node)"
      printf "NODE_VER=%s\n" "$(node -v)"
      printf "NPM_BIN=%s\n" "$(command -v npm)"
      printf "NPM_VER=%s\n" "$(npm -v)"
      printf "NPX_BIN=%s\n" "$(command -v npx)"
      printf "PATH=%s\n" "$PATH"
    '
  fi
}

resolution_field() {
  local key="$1"
  local text="$2"
  printf '%s\n' "$text" | sed -n "s/^${key}=//p" | tail -n 1
}

# Acceptance is a new shell started from the original PATH plus the persisted
# startup file. An export in this process does not count.
assert_later_shell() {
  local kind="$1"
  local expect_npm="${2:-}"
  local text node_bin node_ver npm_bin npm_ver npx_bin path_value
  text="$(shell_resolution "$kind")"
  node_bin="$(resolution_field NODE_BIN "$text")"
  node_ver="$(resolution_field NODE_VER "$text")"
  npm_bin="$(resolution_field NPM_BIN "$text")"
  npm_ver="$(resolution_field NPM_VER "$text")"
  npx_bin="$(resolution_field NPX_BIN "$text")"
  path_value="$(resolution_field PATH "$text")"
  if [[ "$node_bin" != "${shim_dir}/node" || "$node_ver" != "v${node_version}" ]]; then
    echo "A later ${kind} shell resolved node to '${node_bin}' (${node_ver}); expected ${shim_dir}/node v${node_version}." >&2
    echo "PATH=${path_value}" >&2
    exit 1
  fi
  if [[ "$npm_bin" != "${shim_dir}/npm" || "$npx_bin" != "${shim_dir}/npx" ]]; then
    echo "A later ${kind} shell resolved npm='${npm_bin}' npx='${npx_bin}'." >&2
    exit 1
  fi
  if ! shim_precedes_exec_daemon "$path_value"; then
    echo "Pinned Node shims are not ahead of /exec-daemon for the later ${kind} shell." >&2
    echo "PATH=${path_value}" >&2
    exit 1
  fi
  if [[ -n "$expect_npm" && "$npm_ver" != "$expect_npm" ]]; then
    echo "A later ${kind} shell sees npm ${npm_ver}; packageManager pins ${expect_npm}." >&2
    exit 1
  fi
  if [[ "$kind" == "bashrc" ]]; then
    verified_path="$path_value"
  fi
}

install_pinned_npm() {
  local current
  current="$(PATH="${prefix}/bin:${PATH-}" "${prefix}/bin/npm" -v)"
  if [[ "$current" == "$npm_version" ]]; then
    return
  fi
  as_root env PATH="${prefix}/bin:${PATH-}" "${prefix}/bin/npm" install -g --prefix "$prefix" "npm@${npm_version}"
  current="$(PATH="${prefix}/bin:${PATH-}" "${prefix}/bin/npm" -v)"
  if [[ "$current" != "$npm_version" ]]; then
    echo "npm resolved to ${current} after install; packageManager pins ${npm_version}." >&2
    exit 1
  fi
}

for shim_name in node npm npx; do
  assert_shim_destination "$shim_name"
done

install_pinned_node
link_owned_shims
persist_profile
persist_bashrc
assert_later_shell bashrc
assert_later_shell profile
install_pinned_npm
assert_later_shell bashrc "$npm_version"
assert_later_shell profile "$npm_version"

export PATH="$verified_path"
hash -r || true
npm ci
