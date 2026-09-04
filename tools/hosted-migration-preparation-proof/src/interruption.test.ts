import { describe, expect, it } from "vitest";

import {
  ACQUISITION_ROLE,
  IMAGE,
  PROOF_ROLE,
  ROW_IDS,
  acquisitionContainerName,
  acquisitionCreateArguments,
  advanceIdCleanup,
  assertCleanEnvironment,
  createCleanupCursor,
  invocationRecord,
  proofContainerName,
  proofCreateArguments,
} from "../scripts/proof-engine.mjs";

const invocation = "1".repeat(64);
const ledgerSha256 = "2".repeat(64);
const invocationDirectory = `/tmp/openspell-wp201-root-proof-${invocation}`;

describe("WP-201 sealed proof engine", () => {
  it("freezes the ordered 28-row proof matrix and deterministic identities", () => {
    expect(ROW_IDS).toEqual([
      "root-fmt",
      "root-check-none",
      "root-clippy-none",
      "root-rustdoc-none",
      "root-test-none",
      "root-check-internal",
      "root-clippy-internal",
      "root-rustdoc-internal",
      "root-test-internal",
      "runtime-fmt",
      "runtime-check-none",
      "runtime-clippy-none",
      "runtime-rustdoc-none",
      "runtime-test-none",
      "runtime-check-internal",
      "runtime-clippy-internal",
      "runtime-rustdoc-internal",
      "runtime-test-internal",
      "runtime-check-all",
      "runtime-clippy-all",
      "runtime-rustdoc-all",
      "runtime-test-all",
      "coordinator-fmt",
      "coordinator-check",
      "coordinator-clippy",
      "coordinator-rustdoc",
      "coordinator-test",
      "root-positive",
    ]);
    expect(acquisitionContainerName(invocation)).toBe(
      `openspell-wp201-${invocation}-acquisition`,
    );
    expect(proofContainerName(invocation, "root-fmt")).toBe(
      `openspell-wp201-${invocation}-proof-root-fmt`,
    );
    expect(invocationRecord(invocation)).toBe(
      `openspell.wp201.invocation.v1\n${invocation}\n`,
    );
    expect(() => proofContainerName(invocation, "not-a-row")).toThrow(
      "invalid WP-201 proof row",
    );
  });

  it("constructs the complete acquisition create suffix", () => {
    expect(
      acquisitionCreateArguments({ invocation, invocationDirectory, uid: 123, gid: 456 }),
    ).toEqual([
      "container",
      "create",
      "--platform",
      "linux/amd64",
      "--pull",
      "never",
      "--label",
      `com.openspell.wp201.invocation=${invocation}`,
      "--label",
      `com.openspell.wp201.role=${ACQUISITION_ROLE}`,
      "--name",
      `openspell-wp201-${invocation}-acquisition`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      "seccomp=builtin",
      "--security-opt",
      "apparmor=docker-default",
      "--ipc",
      "private",
      "--cgroupns",
      "private",
      "--userns",
      "host",
      "--runtime",
      "runc",
      "--restart",
      "no",
      "--init=false",
      "--log-driver",
      "none",
      "--hostname",
      "wp201-acquisition",
      "--user",
      "123:456",
      "--network",
      "bridge",
      "--pids-limit",
      "128",
      "--memory",
      "2g",
      "--memory-swap",
      "2g",
      "--cpus",
      "2",
      "--ulimit",
      "nofile=1024:1024",
      "--shm-size",
      "256m",
      "--mount",
      `type=bind,src=${invocationDirectory}/source,dst=/input/source,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
      "--mount",
      `type=bind,src=${invocationDirectory}/control/acquisition.sh,dst=/input/control.sh,readonly,bind-propagation=rprivate`,
      "--tmpfs",
      "/output:rw,nodev,nosuid,exec,size=1073741824,mode=0700,uid=123,gid=456",
      "--tmpfs",
      "/tmp:rw,nodev,nosuid,noexec,size=1073741824,mode=0700,uid=123,gid=456",
      "--tmpfs",
      "/wp201-home:rw,nodev,nosuid,noexec,size=16777216,mode=0700,uid=123,gid=456",
      "--workdir",
      "/tmp",
      "--entrypoint",
      "/usr/bin/env",
      IMAGE,
      "-i",
      "PATH=/usr/local/cargo/bin:/usr/bin:/bin",
      "HOME=/wp201-home",
      "CARGO_HOME=/output/cargo-home",
      "TMPDIR=/tmp",
      "RUSTUP_HOME=/usr/local/rustup",
      "RUSTUP_NO_UPDATE_CHECK=1",
      "CARGO_TERM_COLOR=never",
      "LANG=C",
      "LC_ALL=C",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-euo",
      "pipefail",
      "-c",
      'test "$(/usr/bin/sha256sum /input/control.sh)" = "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258  /input/control.sh"; exec /bin/bash --noprofile --norc -euo pipefail /input/control.sh',
      "wp201-acquisition-bootstrap",
    ]);
  });

  it("constructs the complete root-fmt proof suffix", () => {
    const arguments_ = proofCreateArguments({
      invocation,
      invocationDirectory,
      ledgerSha256,
      rowId: "root-fmt",
    });
    expect(arguments_.slice(0, 14)).toEqual([
      "container",
      "create",
      "--interactive",
      "--platform",
      "linux/amd64",
      "--pull",
      "never",
      "--label",
      `com.openspell.wp201.invocation=${invocation}`,
      "--label",
      `com.openspell.wp201.role=${PROOF_ROLE}`,
      "--name",
      `openspell-wp201-${invocation}-proof-root-fmt`,
      "--read-only",
    ]);
    expect(arguments_).toContain("--network");
    expect(arguments_[arguments_.indexOf("--network") + 1]).toBe("none");
    expect(arguments_).toContain(
      `type=bind,src=${invocationDirectory}/acquisition/vendor,dst=/input/vendor,readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    );
    expect(arguments_.at(-3)).toBe("wp201-proof-bootstrap");
    expect(arguments_.at(-2)).toBe(ledgerSha256);
    expect(arguments_.at(-1)).toBe("root-fmt");
    expect(arguments_.filter((argument) => argument === IMAGE)).toHaveLength(1);
  });

  it("refuses ambient control variables and invocation path substitution", () => {
    expect(() => assertCleanEnvironment({ PATH: "/usr/bin" })).not.toThrow();
    expect(() => assertCleanEnvironment({ DOCKER_HOST: "unix:///tmp/not-used" })).toThrow(
      "refused ambient environment",
    );
    expect(() =>
      acquisitionCreateArguments({
        invocation,
        invocationDirectory: `/tmp/not-the-prefix-${invocation}`,
        uid: 123,
        gid: 456,
      }),
    ).toThrow("WP-201 invocation path identity mismatch");
  });

  it("carries cleanup state forward and cannot authorize a third removal", () => {
    const id = "a".repeat(64);
    const cursor = createCleanupCursor([id, id]);
    expect(cursor.ids).toEqual([{ id, state: "remove-1" }]);

    const afterFirstRemove = advanceIdCleanup(cursor.ids[0], "remove-1", "ambiguous");
    expect(afterFirstRemove.state).toBe("absence-1");
    const afterFirstProbe = advanceIdCleanup(afterFirstRemove, "absence-1", "present");
    expect(afterFirstProbe.state).toBe("remove-2");
    const afterSecondRemove = advanceIdCleanup(afterFirstProbe, "remove-2", "error");
    expect(afterSecondRemove.state).toBe("absence-2");
    const failed = advanceIdCleanup(afterSecondRemove, "absence-2", "ambiguous");
    expect(failed.state).toBe("failed");
    expect(() => advanceIdCleanup(failed, "remove-1", "ok")).toThrow(
      "cleanup operation replay or reorder",
    );
  });
});
