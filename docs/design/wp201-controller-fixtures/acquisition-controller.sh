#!/bin/bash
set -euo pipefail
umask 077
[[ $# -eq 0 ]]

authority_ledger() {
  local root=$1
  local output=$2
  local keyed=${output}.keyed
  local rows=${output}.rows
  local body=${output}.body
  local path relative logical mode size digest
  local records=0 files=0 directories=0 bytes=0
  : >"$keyed"
  while IFS= read -r -d '' path; do
    [[ -d "$path" && ! -L "$path" ]]
    relative=${path#"$root"}
    relative=${relative#/}
    if [[ -n "$relative" ]]; then
      [[ "$relative" =~ ^[A-Za-z0-9._+@/-]+$ ]]
      logical=toolchain/$relative
    else
      logical=toolchain
    fi
    printf 'D\t%s\tD\t0555\t%s\n' "$logical" "$logical" >>"$keyed"
    ((records += 1, directories += 1))
  done < <(/usr/bin/find "$root" -xdev -type d -print0)
  while IFS= read -r -d '' path; do
    [[ -f "$path" && ! -L "$path" ]]
    [[ $(/usr/bin/stat -c '%h' -- "$path") == 1 ]]
    relative=${path#"$root"/}
    [[ -n "$relative" && "$relative" =~ ^[A-Za-z0-9._+@/-]+$ ]]
    mode=0444
    if (( (8#$(/usr/bin/stat -c '%a' -- "$path") & 8#111) != 0 )); then
      mode=0555
    fi
    size=$(/usr/bin/stat -c '%s' -- "$path")
    digest=$(/usr/bin/sha256sum -- "$path")
    digest=${digest%% *}
    printf 'T\t%s\tT\t%s\t%s\t%s\t%s\n' \
      "$relative" "$mode" "$size" "$digest" "$relative" >>"$keyed"
    ((records += 1, files += 1, bytes += size))
  done < <(/usr/bin/find "$root" -xdev -type f -print0)
  [[ -z $(/usr/bin/find "$root" -xdev ! -type d ! -type f -print -quit) ]]
  LANG=C /usr/bin/sort -o "$keyed" "$keyed"
  /usr/bin/cut -f3- "$keyed" >"$rows"
  {
    printf 'openspell.wp201.toolchain-authority.v1\nrecords\t%s\n' "$records"
    /usr/bin/cat "$rows"
  } >"$body"
  digest=$(/usr/bin/sha256sum -- "$body")
  digest=${digest%% *}
  {
    /usr/bin/cat "$body"
    printf 'end\t%s\n' "$digest"
  } >"$output"
  /usr/bin/rm -- "$keyed" "$rows" "$body"
  printf '%s %s %s %s %s\n' "$files" "$directories" "$bytes" "$records" "$(/usr/bin/stat -c '%s' -- "$output")"
}

require_authority() {
  local root=$1
  local output=$2
  local expected_stats=$3
  local expected_digest=$4
  [[ $(authority_ledger "$root" "$output") == "$expected_stats" ]]
  local actual=$(/usr/bin/sha256sum -- "$output")
  [[ ${actual%% *} == "$expected_digest" ]]
}

require_source_input() {
  local path=$1
  local size=$2
  local digest=$3
  [[ -f "$path" && ! -L "$path" ]]
  [[ $(/usr/bin/stat -c '%a:%h:%s' -- "$path") == "444:1:$size" ]]
  local actual=$(/usr/bin/sha256sum -- "$path")
  [[ ${actual%% *} == "$digest" ]]
}

require_source_input /input/source/tools/hosted-migration-preparation-proof/Cargo.toml 558 \
  5c89e16cac4721f4a968b2089efcea8fb9c1fe98225d6979166e2c2a3461bad9
require_source_input /input/source/tools/hosted-migration-preparation-proof/Cargo.lock 15208 \
  f3455774926880919588246bc9fc422e3ece13c29250862b4249b91b55ecbc86
require_source_input /input/source/tools/hosted-migration-preparation-proof/rust-toolchain.toml 86 \
  8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e
require_source_input /input/source/tools/hosted-migration-root-authority/Cargo.toml 787 \
  7639e2f59bb0c745b54a192478d86bba1ab1a046066ea490efa6b783e4e2860a
require_source_input /input/source/tools/hosted-migration-root-authority/Cargo.lock 13741 \
  bd460b4ca9b06241a393eb9d4b5bcc05b68a6d6af844fab1f9a683826979f6f5
require_source_input /input/source/tools/hosted-migration-root-authority/rust-toolchain.toml 86 \
  8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e
require_source_input /input/source/tools/hosted-migration-runtime-proof/Cargo.toml 1047 \
  cfca33ad8a621f30fd54c4a9843eb1dd2add8a91cb4d785c60cabd4ccb945364
require_source_input /input/source/tools/hosted-migration-runtime-proof/Cargo.lock 15493 \
  58e3c00b558af03db96516e7e62f5df170630a28a9c29395b1e1de477a82f6aa
require_source_input /input/source/tools/hosted-migration-runtime-proof/rust-toolchain.toml 86 \
  8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e

normalize_tree() {
  local root=$1
  local kind=$2
  local path mode uid_gid
  while IFS= read -r -d '' path; do
    [[ -d "$path" && ! -L "$path" ]]
    uid_gid=$(/usr/bin/stat -c '%u:%g' -- "$path")
    [[ "$uid_gid" == "$(/usr/bin/id -u):$(/usr/bin/id -g)" ]]
    mode=$(/usr/bin/stat -c '%a' -- "$path")
    (( (8#$mode & 8#700) == 8#700 ))
    (( (8#$mode & 8#7022) == 0 ))
  done < <(/usr/bin/find "$root" -xdev -type d -print0)
  while IFS= read -r -d '' path; do
    [[ -f "$path" && ! -L "$path" ]]
    [[ $(/usr/bin/stat -c '%h' -- "$path") == 1 ]]
    uid_gid=$(/usr/bin/stat -c '%u:%g' -- "$path")
    [[ "$uid_gid" == "$(/usr/bin/id -u):$(/usr/bin/id -g)" ]]
    mode=$(/usr/bin/stat -c '%a' -- "$path")
    (( (8#$mode & 8#600) == 8#600 ))
    (( (8#$mode & 8#7022) == 0 ))
    if [[ "$kind" == toolchain && $((8#$mode & 8#111)) -ne 0 ]]; then
      /usr/bin/chmod 0555 -- "$path"
    else
      /usr/bin/chmod 0444 -- "$path"
    fi
  done < <(/usr/bin/find "$root" -xdev -type f -print0)
  [[ -z $(/usr/bin/find "$root" -xdev ! -type d ! -type f -print -quit) ]]
  while IFS= read -r -d '' path; do
    /usr/bin/chmod 0555 -- "$path"
  done < <(/usr/bin/find "$root" -xdev -depth -type d -print0)
}

require_normalized_tree() {
  local root=$1
  local kind=$2
  local expected_files=$3
  local expected_directories=$4
  local expected_bytes=$5
  local files directories bytes path mode
  files=$(/usr/bin/find "$root" -xdev -type f -printf . | /usr/bin/wc -c)
  directories=$(/usr/bin/find "$root" -xdev -type d -printf . | /usr/bin/wc -c)
  bytes=$(/usr/bin/find "$root" -xdev -type f -printf '%s\n' | /usr/bin/awk '{ total += $1 } END { print total + 0 }')
  [[ "$files $directories $bytes" == "$expected_files $expected_directories $expected_bytes" ]]
  [[ -z $(/usr/bin/find "$root" -xdev -type d ! -perm 0555 -print -quit) ]]
  [[ -z $(/usr/bin/find "$root" -xdev ! -type d ! -type f -print -quit) ]]
  while IFS= read -r -d '' path; do
    [[ -f "$path" && ! -L "$path" ]]
    [[ $(/usr/bin/stat -c '%h' -- "$path") == 1 ]]
    mode=$(/usr/bin/stat -c '%a' -- "$path")
    if [[ "$kind" == toolchain ]]; then
      [[ "$mode" == 444 || "$mode" == 555 ]]
    else
      [[ "$mode" == 444 ]]
    fi
  done < <(/usr/bin/find "$root" -xdev -type f -print0)
}

/bin/mkdir -p /output/toolchain /output/rustup-cargo /output/cargo-home
require_authority /usr/local/rustup /tmp/base.ledger '156 26 620842587 182 28579' \
  a77010df3812df474f968ff3b7e85ec0f23d6e819f4f6d7ea5b95b276efdc8a6
/bin/cp -R /usr/local/rustup/. /output/toolchain/
require_authority /output/toolchain /tmp/copied.ledger '156 26 620842587 182 28579' \
  a77010df3812df474f968ff3b7e85ec0f23d6e819f4f6d7ea5b95b276efdc8a6
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/rustup-cargo \
  RUSTUP_HOME=/output/toolchain RUSTUP_NO_UPDATE_CHECK=1 LANG=C LC_ALL=C \
  /usr/local/cargo/bin/rustup component add \
  --toolchain 1.97.1-x86_64-unknown-linux-gnu rustfmt clippy
require_authority /output/toolchain /tmp/final.ledger '168 28 653573520 196 30553' \
  6078f49e711c3a7059e11a8a7b37f5f49837c792523bd914e0592b42d8f087a4
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fetch \
  --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --locked
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fetch \
  --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --locked
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fetch \
  --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --locked
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo vendor \
  --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml \
  --sync /input/source/tools/hosted-migration-root-authority/Cargo.toml \
  --sync /input/source/tools/hosted-migration-runtime-proof/Cargo.toml \
  --locked --versioned-dirs /output/vendor >/tmp/vendor.stdout
[[ -f /tmp/vendor.stdout && ! -L /tmp/vendor.stdout ]]
[[ $(/usr/bin/stat -c '%u:%g:%h' -- /tmp/vendor.stdout) == "$(/usr/bin/id -u):$(/usr/bin/id -g):1" ]]
[[ $(/usr/bin/stat -c '%s' -- /tmp/vendor.stdout) -le 65536 ]]
/usr/bin/rm -- /tmp/vendor.stdout
/usr/bin/rm --recursive --force --one-file-system -- /output/cargo-home /output/rustup-cargo
[[ ! -e /output/cargo-home && ! -e /output/rustup-cargo ]]
[[ $(/usr/bin/find /output -mindepth 1 -maxdepth 1 -printf '%f\n' | LANG=C /usr/bin/sort) == $'toolchain\nvendor' ]]
normalize_tree /output/vendor vendor
normalize_tree /output/toolchain toolchain
require_normalized_tree /output/vendor vendor 3657 941 67159121
require_normalized_tree /output/toolchain toolchain 168 28 653573520
require_authority /output/toolchain /tmp/normalized.ledger '168 28 653573520 196 30553' \
  6078f49e711c3a7059e11a8a7b37f5f49837c792523bd914e0592b42d8f087a4
/usr/bin/rm -- /tmp/base.ledger /tmp/copied.ledger /tmp/final.ledger
/usr/bin/rm -- /tmp/normalized.ledger
printf 'openspell.wp201.acquisition-archive.v1\n'
/usr/bin/tar --create --file=- --format=ustar --blocking-factor=1 --sort=name \
  --numeric-owner --owner=0 --group=0 --mtime=@0 --directory=/output toolchain vendor
