#!/bin/sh
# Release build of the Linux addon, run inside the build image by both CI systems:
#   - quay.io/pypa/manylinux_2_28_<arch> for linux-<arch>-gnu (glibc >= 2.28)
#   - node:22-alpine for linux-<arch>-musl
# GitLab runs it as the job script in that image; GitHub Actions through `docker run` with
# the checkout mounted as the working directory.
#
# It installs the toolchains, builds the addon and the TypeScript output, and checks the
# result: the committed loader and type declarations match the build, a gnu addon needs no
# newer glibc than the baseline, and the offline smoke test passes.
#
# The caller provides network access to the upstream crates (GitLab: the CITOKEN git
# credential). CARGO_HOME and PNPM_STORE_DIR may point into the checkout for caching.
#
# Usage: sh scripts/ci/build-linux.sh

set -eu

GLIBC_BASELINE="2.28"

# Installs the system packages the aws-lc-rs build needs, plus Node.js where the image lacks it.
install_system_packages() {
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y -q clang cmake perl
    install_node
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache build-base clang cmake curl git linux-headers perl
  else
    echo "build-linux: unsupported build image" >&2
    exit 1
  fi
}

# Installs the latest Node.js 22 for this architecture into /usr/local.
install_node() {
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "build-linux: unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  dist="https://nodejs.org/dist/latest-v22.x"
  tarball=$(curl -fsSL "${dist}/SHASUMS256.txt" | awk -v suffix="linux-${arch}.tar.gz" '$2 ~ suffix "$" { print $2 }')
  curl -fsSL "${dist}/${tarball}" | tar -xz -C /usr/local --strip-components=1
}

# Installs rustup and the stable toolchain into CARGO_HOME unless cargo is already there.
install_rust() {
  export CARGO_HOME="${CARGO_HOME:-${HOME}/.cargo}"
  export PATH="${CARGO_HOME}/bin:${PATH}"
  if ! command -v cargo >/dev/null 2>&1 || ! cargo --version >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
  fi
}

# Fails when the committed loader or type declarations differ from what the build generated.
check_generated_files() {
  # The checkout may belong to another user than the container's.
  git config --global --add safe.directory "$(pwd)"
  if ! git diff --exit-code -- native/index.cjs native/index.d.cts; then
    echo "build-linux: native/index.cjs or native/index.d.cts is out of date;" \
      "rebuild and commit it" >&2
    exit 1
  fi
}

# Fails when a gnu addon requires a newer glibc than the baseline.
check_glibc() {
  for addon in native/lkrequest.linux-*-gnu.node; do
    [ -e "${addon}" ] || continue
    required=$(objdump -T "${addon}" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/GLIBC_//' \
      | sort -uV | tail -1)
    echo "build-linux: ${addon} requires glibc ${required} (baseline ${GLIBC_BASELINE})"
    if [ "$(printf '%s\n%s\n' "${required}" "${GLIBC_BASELINE}" | sort -V | tail -1)" \
      != "${GLIBC_BASELINE}" ]; then
      echo "build-linux: the glibc baseline regressed to ${required}" >&2
      exit 1
    fi
  done
}

echo "build-linux: [1/5] system packages"
install_system_packages
install_rust
# A cdylib cannot be built with musl's default static C runtime.
if [ -e /etc/alpine-release ]; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=-crt-static"
  # napi takes an aarch64 musl build for a cross build and sets the cross linker
  # (aarch64-linux-musl-gcc) unless this is already set; natively, the system cc links.
  export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER:-cc}"
fi
node --version
rustc --version

echo "build-linux: [2/5] JavaScript dependencies"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
pnpm install --frozen-lockfile --config.confirm-modules-purge=false ${PNPM_STORE_DIR:+--store-dir "${PNPM_STORE_DIR}"}

echo "build-linux: [3/5] native addon"
# A restored target/ cache or an earlier job must not leave other addons behind.
rm -f native/*.node
pnpm build:native

echo "build-linux: [4/5] checks"
check_generated_files
check_glibc

echo "build-linux: [5/5] TypeScript output and smoke test"
pnpm build:ts
node scripts/smoke.mjs
