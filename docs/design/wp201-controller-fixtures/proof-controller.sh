#!/bin/bash
set -euo pipefail
umask 077
[[ $# -eq 1 ]]
row_id=$1

write_directory_rows() {
  local root=$1
  local logical_root=$2
  local keyed=$3
  local path relative logical
  while IFS= read -r -d '' path; do
    [[ -d "$path" && ! -L "$path" ]]
    [[ $(/usr/bin/stat -c '%a' -- "$path") == 555 ]]
    relative=${path#"$root"}
    relative=${relative#/}
    if [[ -n "$relative" ]]; then
      [[ "$relative" =~ ^[A-Za-z0-9._+@/-]+$ ]]
      logical=$logical_root/$relative
    else
      logical=$logical_root
    fi
    printf 'D\t%s\tD\t0555\t%s\n' "$logical" "$logical" >>"$keyed"
  done < <(/usr/bin/find "$root" -xdev -type d -print0)
  [[ -z $(/usr/bin/find "$root" -xdev ! -type d ! -type f -print -quit) ]]
}

write_file_rows() {
  local tag=$1
  local root=$2
  local keyed=$3
  local path relative mode size digest
  while IFS= read -r -d '' path; do
    [[ -f "$path" && ! -L "$path" ]]
    [[ $(/usr/bin/stat -c '%h' -- "$path") == 1 ]]
    relative=${path#"$root"/}
    [[ -n "$relative" && "$relative" =~ ^[A-Za-z0-9._+@/-]+$ ]]
    mode=$(/usr/bin/stat -c '%a' -- "$path")
    if [[ "$tag" == T ]]; then
      [[ "$mode" == 444 || "$mode" == 555 ]]
      mode=0$mode
    else
      [[ "$mode" == 444 ]]
      mode=0444
    fi
    size=$(/usr/bin/stat -c '%s' -- "$path")
    digest=$(/usr/bin/sha256sum -- "$path")
    digest=${digest%% *}
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$tag" "$relative" "$tag" "$mode" "$size" "$digest" "$relative" >>"$keyed"
  done < <(/usr/bin/find "$root" -xdev -type f -print0)
}

write_control_row() {
  local logical=$1
  local path=$2
  local keyed=$3
  [[ -f "$path" && ! -L "$path" ]]
  [[ $(/usr/bin/stat -c '%a' -- "$path") == 444 ]]
  [[ $(/usr/bin/stat -c '%h' -- "$path") == 1 ]]
  local size digest
  size=$(/usr/bin/stat -c '%s' -- "$path")
  digest=$(/usr/bin/sha256sum -- "$path")
  digest=${digest%% *}
  printf 'C\t%s\tC\t0444\t%s\t%s\t%s\n' "$logical" "$size" "$digest" "$logical" >>"$keyed"
}

full_ledger() {
  local output=$1
  local keyed=${output}.keyed
  local rows=${output}.rows
  local body=${output}.body
  : >"$keyed"
  write_directory_rows /input/source source "$keyed"
  write_directory_rows /input/vendor vendor "$keyed"
  write_directory_rows /input/toolchain toolchain "$keyed"
  write_file_rows S /input/source "$keyed"
  write_file_rows V /input/vendor "$keyed"
  write_file_rows T /input/toolchain "$keyed"
  write_control_row control/proof.sh /input/control.sh "$keyed"
  write_control_row etc/hostname /etc/hostname "$keyed"
  write_control_row etc/hosts /etc/hosts "$keyed"
  write_control_row etc/resolv.conf /etc/resolv.conf "$keyed"
  [[ $(/usr/bin/wc -l <"$keyed") == 4853 ]]
  LANG=C /usr/bin/sort -o "$keyed" "$keyed"
  /usr/bin/cut -f3- "$keyed" >"$rows"
  {
    printf 'openspell.wp201.vendor-ledger.v1\nrecords\t4853\n'
    /usr/bin/cat "$rows"
  } >"$body"
  local digest
  digest=$(/usr/bin/sha256sum -- "$body")
  digest=${digest%% *}
  {
    /usr/bin/cat "$body"
    printf 'end\t%s\n' "$digest"
  } >"$output"
  /usr/bin/rm -- "$keyed" "$rows" "$body"
}

toolchain_authority() {
  local output=$1
  local keyed=${output}.keyed
  local rows=${output}.rows
  local body=${output}.body
  : >"$keyed"
  write_directory_rows /input/toolchain toolchain "$keyed"
  write_file_rows T /input/toolchain "$keyed"
  [[ $(/usr/bin/wc -l <"$keyed") == 196 ]]
  LANG=C /usr/bin/sort -o "$keyed" "$keyed"
  /usr/bin/cut -f3- "$keyed" >"$rows"
  {
    printf 'openspell.wp201.toolchain-authority.v1\nrecords\t196\n'
    /usr/bin/cat "$rows"
  } >"$body"
  local digest
  digest=$(/usr/bin/sha256sum -- "$body")
  digest=${digest%% *}
  {
    /usr/bin/cat "$body"
    printf 'end\t%s\n' "$digest"
  } >"$output"
  /usr/bin/rm -- "$keyed" "$rows" "$body"
}

verify_inputs() {
  local suffix=$1
  local full=/fixtures/full-$suffix.ledger
  local authority=/fixtures/toolchain-$suffix.ledger
  [[ $(/usr/bin/stat -c '%a:%h' -- /input/vendor-ledger.v1) == 444:1 ]]
  full_ledger "$full"
  /usr/bin/cmp --silent /input/vendor-ledger.v1 "$full"
  toolchain_authority "$authority"
  [[ $(/usr/bin/stat -c '%s' -- "$authority") == 30553 ]]
  local digest
  digest=$(/usr/bin/sha256sum -- "$authority")
  [[ ${digest%% *} == 6078f49e711c3a7059e11a8a7b37f5f49837c792523bd914e0592b42d8f087a4 ]]
}

verify_mounts() {
  local table=/fixtures/mount-table
  local actual=/fixtures/writable-mounts
  local expected=/fixtures/expected-writable-mounts
  /usr/bin/awk '
    {
      separator = 0
      for (field = 7; field <= NF; field += 1) {
        if ($field == "-") { separator = field; break }
      }
      if (separator == 0) exit 1
      printf "%s\t%s\t%s\t%s\t%s\n", $5, $4, $(separator + 1), $6, $(separator + 3)
    }
  ' /proc/self/mountinfo >"$table"
  [[ -z $(/usr/bin/cut -f1 "$table" | LANG=C /usr/bin/sort | /usr/bin/uniq -d) ]]
  /usr/bin/awk -F '\t' 'index("," $4 ",", ",rw,") { print $1 }' "$table" | LANG=C /usr/bin/sort >"$actual"
  printf '%s\n' \
    /cargo /dev /dev/mqueue /dev/pts /dev/shm /fixtures \
    /proc /proc/interrupts /proc/kcore /proc/keys /proc/latency_stats /proc/timer_list \
    /target /tmp /wp201-home | LANG=C /usr/bin/sort >"$expected"
  /usr/bin/cmp --silent "$expected" "$actual"

  require_mount() {
    local path=$1
    local root=$2
    local filesystem=$3
    local options=$4
    local super_options=$5
    local row
    row=$(/usr/bin/awk -F '\t' -v path="$path" '$1 == path { print }' "$table")
    [[ -n "$row" && $(printf '%s\n' "$row" | /usr/bin/wc -l) == 1 ]]
    local actual_path actual_root actual_filesystem actual_options actual_super
    IFS=$'\t' read -r actual_path actual_root actual_filesystem actual_options actual_super <<<"$row"
    [[ "$actual_path" == "$path" && "$actual_root" == "$root" ]]
    [[ "$actual_filesystem" == "$filesystem" && "$actual_options" == "$options" ]]
    [[ "$super_options" == '*' || "$actual_super" == "$super_options" ]]
  }

  require_read_only_mount() {
    local path=$1
    local row
    row=$(/usr/bin/awk -F '\t' -v path="$path" '$1 == path { print }' "$table")
    [[ -n "$row" && $(printf '%s\n' "$row" | /usr/bin/wc -l) == 1 ]]
    local ignored actual_options
    IFS=$'\t' read -r ignored ignored ignored actual_options ignored <<<"$row"
    [[ ",$actual_options," == *,ro,* ]]
  }

  require_mount / / overlay ro,relatime '*'
  require_mount /sys / sysfs ro,nosuid,nodev,noexec,relatime '*'
  require_mount /sys/fs/cgroup / cgroup2 ro,nosuid,nodev,noexec,relatime '*'
  require_mount /cargo / tmpfs rw,nosuid,nodev,noexec,relatime rw,size=262144k,mode=700,inode64
  require_mount /target / tmpfs rw,nosuid,nodev,relatime rw,size=4194304k,mode=700,inode64
  require_mount /tmp / tmpfs rw,nosuid,nodev,noexec,relatime rw,size=1048576k,mode=700,inode64
  require_mount /fixtures / tmpfs rw,nosuid,nodev,noexec,relatime rw,size=2097152k,mode=700,inode64
  require_mount /wp201-home / tmpfs rw,nosuid,nodev,noexec,relatime rw,size=16384k,mode=700,inode64
  require_mount /dev/shm / tmpfs rw,nosuid,nodev,noexec,relatime rw,size=2097152k,inode64
  [[ $(/usr/bin/stat -c '%a:%u:%g' /cargo /target /tmp /fixtures /wp201-home) == $'700:0:0\n700:0:0\n700:0:0\n700:0:0\n700:0:0' ]]
  [[ $(/usr/bin/stat -c '%a:%u:%g' /dev/shm) == 1777:0:0 ]]

  local actual_proc=/fixtures/proc-mounts
  local expected_proc=/fixtures/expected-proc-mounts
  /usr/bin/awk -F '\t' '$1 == "/proc" || index($1, "/proc/") == 1 { print $1 }' "$table" | LANG=C /usr/bin/sort >"$actual_proc"
  printf '%s\n' /proc /proc/acpi /proc/asound /proc/bus /proc/fs /proc/interrupts \
    /proc/irq /proc/kcore /proc/keys /proc/latency_stats /proc/scsi /proc/sys \
    /proc/sysrq-trigger /proc/timer_list | LANG=C /usr/bin/sort >"$expected_proc"
  /usr/bin/cmp --silent "$expected_proc" "$actual_proc"
  require_mount /proc / proc rw,nosuid,nodev,noexec,relatime rw
  require_mount /proc/bus /bus proc ro,nosuid,nodev,noexec,relatime rw
  require_mount /proc/fs /fs proc ro,nosuid,nodev,noexec,relatime rw
  require_mount /proc/irq /irq proc ro,nosuid,nodev,noexec,relatime rw
  require_mount /proc/sys /sys proc ro,nosuid,nodev,noexec,relatime rw
  require_mount /proc/sysrq-trigger /sysrq-trigger proc ro,nosuid,nodev,noexec,relatime rw
  require_mount /proc/acpi / tmpfs ro,relatime ro,size=4k,nr_inodes=1,inode64
  require_mount /proc/asound / tmpfs ro,relatime ro,size=4k,nr_inodes=1,inode64
  require_mount /proc/scsi / tmpfs ro,relatime ro,size=4k,nr_inodes=1,inode64
  for path in /proc/interrupts /proc/kcore /proc/keys /proc/latency_stats /proc/timer_list; do
    require_mount "$path" /null tmpfs rw,nosuid '*'
  done

  for path in /input/source /input/vendor /input/toolchain /input/vendor-ledger.v1 \
    /input/control.sh /etc/hostname /etc/hosts /etc/resolv.conf; do
    require_read_only_mount "$path"
  done
  [[ -z $(/usr/bin/awk '$5 ~ "^/input/(source|vendor|toolchain)/" { print; exit }' /proc/self/mountinfo) ]]
}

namespace_id() {
  local namespace=$1
  local value
  value=$(/usr/bin/readlink "/proc/self/ns/$namespace")
  [[ "$value" =~ ^$namespace:\[[0-9]+\]$ ]]
  printf '%s' "$value"
}

verify_namespace_gate() {
  local namespace self_value init_value host_value
  for namespace in cgroup ipc mnt net pid user uts; do
    self_value=$(namespace_id "$namespace")
    init_value=$(/usr/bin/readlink "/proc/1/ns/$namespace")
    [[ "$self_value" == "$init_value" ]]
    printf -v "proof_namespace_$namespace" '%s' "$self_value"
  done
  printf 'openspell.wp201.namespace-ready.v1\n'
  local frame=/fixtures/namespace-frame
  /usr/bin/head -c 513 >"$frame"
  [[ $(/usr/bin/stat -c '%a:%u:%g:%h' -- "$frame") == 600:0:0:1 ]]
  [[ $(/usr/bin/stat -c '%s' -- "$frame") -le 512 ]]
  if /usr/bin/od -An -v -tx1 -- "$frame" | /usr/bin/grep -q ' 00'; then
    false
  fi
  [[ $(/usr/bin/tail -c 1 -- "$frame" | /usr/bin/od -An -v -tu1 | /usr/bin/tr -d ' \n') == 10 ]]
  [[ $(/usr/bin/wc -l <"$frame") == 8 ]]
  local -a lines
  mapfile -t lines <"$frame"
  [[ ${#lines[@]} -eq 8 ]]
  [[ "${lines[0]}" == openspell.wp201.namespace-gate.v1 ]]
  local index=1
  for namespace in cgroup ipc mnt net pid user uts; do
    host_value=${lines[$index]}
    [[ "$host_value" =~ ^$namespace:\[[0-9]{1,20}\]$ ]]
    self_value=$(namespace_id "$namespace")
    if [[ "$namespace" == user ]]; then
      [[ "$self_value" == "$host_value" ]]
    else
      [[ "$self_value" != "$host_value" ]]
    fi
    ((index += 1))
  done
  /usr/bin/rm -- "$frame"
}

verify_namespaces_stable() {
  local namespace expected expected_variable
  for namespace in cgroup ipc mnt net pid user uts; do
    expected_variable=proof_namespace_$namespace
    expected=${!expected_variable}
    [[ $(namespace_id "$namespace") == "$expected" ]]
  done
}

verify_lock() {
  local path=$1
  local packages=$2
  local registries=$3
  local checksums=$4
  shift 4
  [[ $(/usr/bin/grep -c '^\[\[package\]\]$' "$path") == "$packages" ]]
  [[ $(/usr/bin/grep -c '^source = "registry+https://github.com/rust-lang/crates.io-index"$' "$path") == "$registries" ]]
  [[ -z $(/usr/bin/grep '^source = ' "$path" | /usr/bin/grep -v '^source = "registry+https://github.com/rust-lang/crates.io-index"$') ]]
  [[ $(/usr/bin/grep -c '^checksum = "[0-9a-f]\{64\}"$' "$path") == "$checksums" ]]
  [[ $((packages - registries)) == $# ]]
  local package
  for package in "$@"; do
    [[ $(/usr/bin/grep -c "^name = \"$package\"$" "$path") == 1 ]]
  done
}

verify_locks() {
  verify_lock /input/source/tools/hosted-migration-preparation-proof/Cargo.lock 68 65 65 \
    openspell-hosted-migration-preparation-proof \
    openspell-hosted-migration-root-authority \
    openspell-hosted-migration-runtime-proof
  verify_lock /input/source/tools/hosted-migration-root-authority/Cargo.lock 61 60 60 \
    openspell-hosted-migration-root-authority
  verify_lock /input/source/tools/hosted-migration-runtime-proof/Cargo.lock 69 68 68 \
    openspell-hosted-migration-runtime-proof
}

[[ -z $(/usr/bin/find /cargo /target /tmp /fixtures /wp201-home -mindepth 1 -print -quit) ]]
verify_mounts
verify_namespace_gate
verify_inputs before
verify_locks
marker_a=openspell.wp201.
marker_b=root-bridge-success.v1
if /usr/bin/grep -a -R -F -l -- "$marker_a$marker_b" /input/control.sh /input/vendor /input/toolchain >/dev/null; then
  exit 1
fi
/bin/mkdir /target/current

set +e
case "$row_id" in
  root-fmt)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fmt --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --all -- --check ;;
  root-check-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo check --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --all-targets ;;
  root-clippy-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo clippy --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --all-targets -- -D warnings ;;
  root-rustdoc-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo rustdoc --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --lib -- -D warnings ;;
  root-test-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --all-targets ;;
  root-check-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo check --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --features wp201-internal --all-targets ;;
  root-clippy-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo clippy --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --features wp201-internal --all-targets -- -D warnings ;;
  root-rustdoc-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo rustdoc --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --features wp201-internal --lib -- -D warnings ;;
  root-test-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --features wp201-internal --all-targets ;;
  runtime-fmt)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fmt --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --all -- --check ;;
  runtime-check-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo check --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --all-targets ;;
  runtime-clippy-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo clippy --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --all-targets -- -D warnings ;;
  runtime-rustdoc-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo rustdoc --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --lib -- -D warnings ;;
  runtime-test-none)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --lib ;;
  runtime-check-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo check --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --features wp201-internal --all-targets ;;
  runtime-clippy-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo clippy --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --features wp201-internal --all-targets -- -D warnings ;;
  runtime-rustdoc-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo rustdoc --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --features wp201-internal --lib -- -D warnings ;;
  runtime-test-internal)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --no-default-features --features wp201-internal --lib ;;
  runtime-check-all)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo check --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --all-features --all-targets ;;
  runtime-clippy-all)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo clippy --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --all-features --all-targets -- -D warnings ;;
  runtime-rustdoc-all)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo rustdoc --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --all-features --lib -- -D warnings ;;
  runtime-test-all)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --all-features --lib ;;
  coordinator-fmt)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fmt --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --all -- --check ;;
  coordinator-check)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo check --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --all-targets ;;
  coordinator-clippy)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo clippy --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --all-targets -- -D warnings ;;
  coordinator-rustdoc)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo rustdoc --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --lib -- -D warnings ;;
  coordinator-test)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --all-targets ;;
  root-positive)
    /usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo test --locked --offline --config net.offline=true --config 'source.crates-io.replace-with="vendored-sources"' --config 'source.vendored-sources.directory="/input/vendor"' --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --no-default-features --features wp201-internal authority_registry_tests::wp201_root_container_bridge_success -- --ignored --exact --nocapture ;;
  *) false ;;
esac
cargo_status=$?
set -e

verify_inputs after
verify_namespaces_stable
exit "$cargo_status"
