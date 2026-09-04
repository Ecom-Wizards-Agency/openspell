import { describe, expect, it } from "vitest";

import {
  ACQUISITION_ROLE,
  IMAGE,
  PROOF_ROLE,
  ROW_IDS,
  PLATFORM_MANIFEST_REFERENCE,
  acquisitionContainerName,
  acquisitionCreateArguments,
  advanceIdCleanup,
  assertCleanEnvironment,
  createCleanupCursor,
  dockerOperationArguments,
  expectedCleanupOperation,
  invocationRecord,
  proofContainerName,
  proofCreateArguments,
  reduceCleanupCursor,
} from "../scripts/proof-engine.mjs";

const invocation = "1".repeat(64);
const ledgerSha256 = "2".repeat(64);
const invocationDirectory = `/tmp/openspell-wp201-root-proof-${invocation}`;
const labelNamespace = ["com", "openspell", "wp201"].join(".");

function settle(
  cursor: ReturnType<typeof createCleanupCursor>,
  operation: string,
  outcome: string,
  id?: string,
): ReturnType<typeof createCleanupCursor> {
  const active = reduceCleanupCursor(cursor, {
    type: "begin-operation",
    operation,
    ...(id === undefined ? {} : { id }),
  });
  const recorded = reduceCleanupCursor(active, { type: "record-result", outcome });
  return reduceCleanupCursor(recorded, { type: "advance" });
}

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
      `${labelNamespace}.invocation=${invocation}`,
      "--label",
      `${labelNamespace}.role=${ACQUISITION_ROLE}`,
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
      [
        "/output:rw",
        "nodev",
        "nosuid",
        "exec",
        "size=1073741824",
        "mode=0700",
        "uid=123",
        "gid=456",
      ].join(","),
      "--tmpfs",
      [
        "/tmp:rw",
        "nodev",
        "nosuid",
        "noexec",
        "size=1073741824",
        "mode=0700",
        "uid=123",
        "gid=456",
      ].join(","),
      "--tmpfs",
      [
        "/wp201-home:rw",
        "nodev",
        "nosuid",
        "noexec",
        "size=16777216",
        "mode=0700",
        "uid=123",
        "gid=456",
      ].join(","),
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

  it("constructs every closed Docker operation suffix without caller-selected names", () => {
    const id = "a".repeat(64);
    const expectedImage = [
      "docker.io/library/rust",
      ":1.97.1-bookworm@sha256:",
      "0e2bcaef56d041a4",
      "86784e54104a81ae",
      "be0da44bd03019bd",
      "70bc0401e42e4a97",
    ].join("");
    expect(IMAGE).toBe(expectedImage);
    expect(PLATFORM_MANIFEST_REFERENCE).toBe(
      [
        "docker.io/library/rust@sha256:",
        "408fe88047cef61a",
        "2087653b0c5255fa",
        "51c0f2d6d94ddedd",
        "7a2562a9b91a46f6",
      ].join(""),
    );
    expect(dockerOperationArguments("context-name")).toEqual(["context", "show"]);
    expect(dockerOperationArguments("context-endpoint")).toEqual([
      "context",
      "inspect",
      "default",
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ]);
    expect(dockerOperationArguments("api-support")).toEqual([
      "version",
      "--format",
      "{{json .}}",
    ]);
    expect(dockerOperationArguments("platform-manifest")).toEqual([
      "manifest",
      "inspect",
      PLATFORM_MANIFEST_REFERENCE,
    ]);
    expect(dockerOperationArguments("cached-image")).toEqual([
      "image",
      "inspect",
      "--platform",
      "linux/amd64",
      IMAGE,
    ]);
    expect(dockerOperationArguments("image-pull")).toEqual([
      "image",
      "pull",
      "--platform",
      "linux/amd64",
      IMAGE,
    ]);
    expect(dockerOperationArguments("label-census", { invocation })).toEqual([
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      `label=${labelNamespace}.invocation=${invocation}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(
      dockerOperationArguments("exact-name-acquisition", { invocation }),
    ).toEqual([
      "container",
      "inspect",
      `openspell-wp201-${invocation}-acquisition`,
    ]);
    expect(
      dockerOperationArguments("exact-name-proof", {
        invocation,
        rowId: "root-fmt",
      }),
    ).toEqual([
      "container",
      "inspect",
      `openspell-wp201-${invocation}-proof-root-fmt`,
    ]);
    expect(dockerOperationArguments("inspect", { id })).toEqual([
      "container",
      "inspect",
      id,
    ]);
    expect(dockerOperationArguments("acquisition-start-attach", { id })).toEqual([
      "container",
      "start",
      "--attach",
      id,
    ]);
    expect(dockerOperationArguments("proof-start-attach", { id })).toEqual([
      "container",
      "start",
      "--attach",
      "--interactive",
      id,
    ]);
    expect(dockerOperationArguments("remove", { id })).toEqual([
      "container",
      "rm",
      "--force",
      "--volumes",
      id,
    ]);
    expect(dockerOperationArguments("absence", { id })).toEqual([
      "container",
      "inspect",
      id,
    ]);
    expect(() =>
      dockerOperationArguments("exact-name-proof", {
        invocation,
        rowId: "root-fmt",
        name: "caller-name",
      }),
    ).toThrow("invalid Docker operation options");
    expect(() =>
      dockerOperationArguments("proof-start-attach", {
        id,
        role: PROOF_ROLE,
      }),
    ).toThrow("invalid Docker operation options");
    expect(() => dockerOperationArguments("run", {})).toThrow(
      "unsupported Docker operation",
    );
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

  it("preserves an active parsed result across latch and never replays a slot", () => {
    const id = "b".repeat(64);
    const initial = createCleanupCursor([id]);
    const active = reduceCleanupCursor(initial, {
      type: "begin-operation",
      operation: "remove-1",
      id,
    });
    const parsed = reduceCleanupCursor(active, {
      type: "record-result",
      outcome: "error",
    });
    const latched = reduceCleanupCursor(parsed, { type: "latch" });
    expect(latched.latched).toBe(true);
    expect(latched.active).toEqual({ operation: "remove-1", id, result: "error" });
    expect(reduceCleanupCursor(latched, { type: "latch" })).toBe(latched);

    const advanced = reduceCleanupCursor(latched, { type: "advance" });
    expect(advanced.ids).toEqual([{ id, state: "absence-1" }]);
    expect(expectedCleanupOperation(advanced)).toEqual({
      operation: "absence-1",
      id,
    });
    expect(() =>
      reduceCleanupCursor(advanced, {
        type: "begin-operation",
        operation: "remove-1",
        id,
      }),
    ).toThrow("cleanup operation replay or reorder");
    expect(() => reduceCleanupCursor(parsed, { type: "record-result", outcome: "error" }))
      .toThrow("cleanup result replay or reorder");
  });

  it("adopts one late final event and advances the complete cleanup sequence once", () => {
    const responseId = "c".repeat(64);
    const finalEventId = "d".repeat(64);
    let cursor = createCleanupCursor([responseId]);
    cursor = settle(cursor, "remove-1", "removed", responseId);
    cursor = settle(cursor, "absence-1", "absent", responseId);
    expect(cursor.phase).toBe("preliminary-census");

    cursor = reduceCleanupCursor(cursor, {
      type: "begin-operation",
      operation: "preliminary-census",
    });
    cursor = reduceCleanupCursor(cursor, {
      type: "adopt-event-id",
      id: finalEventId,
    });
    expect(cursor.finalIds).toEqual([{ id: finalEventId, state: "remove-1" }]);
    cursor = reduceCleanupCursor(cursor, {
      type: "record-result",
      outcome: "deferred-event",
    });
    cursor = reduceCleanupCursor(cursor, { type: "advance" });
    expect(cursor.phase).toBe("close");

    cursor = settle(cursor, "send-close", "sent");
    cursor = settle(cursor, "settle-watcher", "reaped");
    expect(cursor.phase).toBe("final-ids");
    expect(cursor.closeSent).toBe(true);
    expect(cursor.watcherReaped).toBe(true);
    cursor = settle(cursor, "remove-1", "error", finalEventId);
    cursor = settle(cursor, "absence-1", "present", finalEventId);
    cursor = settle(cursor, "remove-2", "removed", finalEventId);
    cursor = settle(cursor, "absence-2", "absent", finalEventId);
    expect(cursor.phase).toBe("final-census");

    cursor = settle(cursor, "final-census", "empty");
    cursor = settle(cursor, "path-helper", "complete");
    cursor = settle(cursor, "parent-absence", "absent");
    expect(cursor).toMatchObject({
      phase: "complete",
      failed: false,
      preliminaryCensus: true,
      finalCensus: true,
      pathCleanup: true,
      parentAbsence: true,
    });
    expect(expectedCleanupOperation(cursor)).toBeNull();
    expect(() =>
      reduceCleanupCursor(cursor, {
        type: "begin-operation",
        operation: "parent-absence",
      }),
    ).toThrow("cleanup operation replay or reorder");
  });

  it("marks a second event or a third unique identity uncertain without adopting it", () => {
    const first = "e".repeat(64);
    const second = "f".repeat(64);
    const third = "0".repeat(64);
    let cursor = createCleanupCursor([first]);
    cursor = reduceCleanupCursor(cursor, { type: "adopt-event-id", id: second });
    expect(cursor.ids).toHaveLength(2);
    cursor = reduceCleanupCursor(cursor, { type: "adopt-event-id", id: third });
    expect(cursor).toMatchObject({ failed: true, eventCount: 2 });
    expect(cursor.ids.map(({ id }: { id: string }) => id)).toEqual([first, second]);

    const full = createCleanupCursor([first, second]);
    const refused = reduceCleanupCursor(full, { type: "adopt-event-id", id: third });
    expect(refused).toMatchObject({ failed: true, eventCount: 1 });
    expect(refused.ids.map(({ id }: { id: string }) => id)).toEqual([
      first,
      second,
    ]);
  });
});
