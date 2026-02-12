#!/usr/bin/env bash
set -euo pipefail

REPO="${BAKKER_REPO:-SebastiaanWouters/bakker}"
VERSION="${BAKKER_VERSION:-latest}"
if [[ -n "${BAKKER_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="${BAKKER_INSTALL_DIR}"
elif [[ -n "${HOME:-}" ]]; then
  INSTALL_DIR="${HOME}/.local/bin"
else
  INSTALL_DIR="/usr/local/bin"
fi
BIN_NAME="bakker"

usage() {
  cat <<'USAGE'
Install bakker CLI from GitHub Releases.

Usage:
  install.sh [options]

Options:
  --version <latest|vX.Y.Z|X.Y.Z>   Version to install (default: latest)
  --install-dir <path>              Install directory (default: $HOME/.local/bin, or /usr/local/bin if HOME is unset)
  --repo <owner/repo>               GitHub repo (default: SebastiaanWouters/bakker)
  --help                            Show this help

Environment overrides:
  BAKKER_VERSION
  BAKKER_INSTALL_DIR
  BAKKER_REPO
USAGE
}

say() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "required command not found: $cmd"
}

download_file() {
  local url="$1"
  local out="$2"
  curl --fail --location --silent --show-error \
    --retry 3 --retry-delay 1 --retry-connrefused \
    "$url" -o "$out"
}

download_try() {
  local url="$1"
  local out="$2"
  curl --fail --location --silent --show-error \
    --retry 2 --retry-delay 1 --retry-connrefused \
    "$url" -o "$out" 2>/dev/null
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  fail "no SHA-256 tool found (need sha256sum or shasum)"
}

normalize_tag() {
  local v="$1"
  if [[ "$v" == v* ]]; then
    printf '%s' "$v"
  else
    printf 'v%s' "$v"
  fi
}

latest_tag_from_redirect() {
  local effective
  effective="$(curl --fail --location --silent --show-error \
    --output /dev/null --write-out '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest")" || return 1
  case "$effective" in
    */releases/tag/*) printf '%s' "${effective##*/}" ;;
    *) return 1 ;;
  esac
}

download_release_binary_pair() {
  local tag_ref="$1"
  local bin_out="$2"
  local sha_out="$3"
  local base
  if [[ "$tag_ref" == "latest" ]]; then
    base="https://github.com/${REPO}/releases/latest/download"
  else
    base="https://github.com/${REPO}/releases/download/${tag_ref}"
  fi
  download_try "${base}/${BIN_NAME}" "$bin_out" || return 1
  download_try "${base}/${BIN_NAME}.sha256" "$sha_out" || return 1
}

download_release_tarball_pair() {
  local tag_ref="$1"
  local tar_out="$2"
  local sha_out="$3"
  local base
  local tar_name="${BIN_NAME}-${tag_ref}.tar.gz"
  if [[ "$tag_ref" == "latest" ]]; then
    return 1
  fi
  base="https://github.com/${REPO}/releases/download/${tag_ref}"
  download_try "${base}/${tar_name}" "$tar_out" || return 1
  download_try "${base}/${tar_name}.sha256" "$sha_out" || return 1
}

verify_sha_pair() {
  local file="$1"
  local sha_file="$2"
  local expected actual
  expected="$(awk '{print $1; exit}' "$sha_file")"
  [[ "$expected" =~ ^[A-Fa-f0-9]{64}$ ]] || return 1
  actual="$(sha256_file "$file")"
  [[ "$actual" == "$expected" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -lt 2 ]] && fail "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --install-dir)
      [[ $# -lt 2 ]] && fail "--install-dir requires a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --repo)
      [[ $# -lt 2 ]] && fail "--repo requires a value"
      REPO="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

need_cmd curl
need_cmd mktemp
need_cmd install
need_cmd awk

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) fail "unsupported OS: $(uname -s) (supported: Linux, Darwin)" ;;
esac

umask 022

TAG="latest"
if [[ "$VERSION" != "latest" ]]; then
  TAG="$(normalize_tag "$VERSION")"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_PATH="${TMP_DIR}/${BIN_NAME}"
SHA_PATH="${TMP_DIR}/${BIN_NAME}.sha256"
TAR_PATH="${TMP_DIR}/${BIN_NAME}.tar.gz"
TAR_SHA_PATH="${TMP_DIR}/${BIN_NAME}.tar.gz.sha256"
RAW_FALLBACK_URL="https://raw.githubusercontent.com/${REPO}/main/cli/${BIN_NAME}"

say "Installing ${BIN_NAME} (${TAG}) from ${REPO}"
if download_release_binary_pair "$TAG" "$BIN_PATH" "$SHA_PATH"; then
  verify_sha_pair "$BIN_PATH" "$SHA_PATH" || fail "checksum verification failed for release binary"
elif [[ "$TAG" != "latest" ]] && download_release_tarball_pair "$TAG" "$TAR_PATH" "$TAR_SHA_PATH"; then
  verify_sha_pair "$TAR_PATH" "$TAR_SHA_PATH" || fail "checksum verification failed for release tarball"
  tar -xzf "$TAR_PATH" -C "$TMP_DIR"
  [[ -f "$BIN_PATH" ]] || fail "release tarball did not contain '${BIN_NAME}'"
elif [[ "$TAG" == "latest" ]]; then
  LATEST_TAG="$(latest_tag_from_redirect || true)"
  if [[ -n "$LATEST_TAG" ]] && download_release_tarball_pair "$LATEST_TAG" "$TAR_PATH" "$TAR_SHA_PATH"; then
    verify_sha_pair "$TAR_PATH" "$TAR_SHA_PATH" || fail "checksum verification failed for release tarball"
    tar -xzf "$TAR_PATH" -C "$TMP_DIR"
    [[ -f "$BIN_PATH" ]] || fail "release tarball did not contain '${BIN_NAME}'"
  else
    printf 'warning: no signed release asset found, falling back to main branch CLI\n' >&2
    download_file "$RAW_FALLBACK_URL" "$BIN_PATH" || fail "failed to download fallback CLI from ${RAW_FALLBACK_URL}"
  fi
else
  fail "release assets not found for ${TAG}"
fi

[[ -s "$BIN_PATH" ]] || fail "downloaded binary is empty"

mkdir -p "$INSTALL_DIR"
[[ -w "$INSTALL_DIR" ]] || fail "install directory is not writable: ${INSTALL_DIR} (use --install-dir)"
install -m 0755 "$BIN_PATH" "${INSTALL_DIR}/${BIN_NAME}"

say "Installed to ${INSTALL_DIR}/${BIN_NAME}"
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  printf 'warning: %s is not on PATH\n' "$INSTALL_DIR" >&2
  printf '         add this to your shell profile:\n' >&2
  printf '         export PATH="%s:$PATH"\n' "$INSTALL_DIR" >&2
fi

"${INSTALL_DIR}/${BIN_NAME}" version
