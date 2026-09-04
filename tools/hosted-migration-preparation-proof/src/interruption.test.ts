import { describe, expect, it } from "vitest";

import {
  ACQUISITION_ROLE,
  CLEANUP_RESERVE_NS,
  IMAGE,
  PROOF_ROLE,
  ROW_IDS,
  PLATFORM_MANIFEST_REFERENCE,
  acquisitionContainerName,
  acquisitionCreateArguments,
  advanceIdCleanup,
  assertCleanEnvironment,
  createBootTimeSample,
  createCleanupCursor,
  createOwnedChildToken,
  dockerEnvironment,
  dockerOperationArguments,
  dockerPrefix,
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
const secondNs = 1_000_000_000n;
const activeDeadlineNs = 300n * secondNs;
const hardDeadlineNs = activeDeadlineNs + CLEANUP_RESERVE_NS;

function clock(nanoseconds: bigint) {
  return createBootTimeSample(nanoseconds);
}

function cleanupCursor(
  ids: readonly string[] = [],
  options: {
    readonly createIssued?: boolean;
    readonly initialNs?: bigint;
    readonly watcherReady?: boolean;
  } = {},
) {
  return createCleanupCursor({
    ids,
    activeDeadlineNs,
    hardDeadlineNs,
    createIssued: options.createIssued ?? ids.length > 0,
    watcherReady: options.watcherReady ?? true,
    sample: clock(options.initialNs ?? 0n),
  });
}

function enterCleanup(
  cursor: ReturnType<typeof createCleanupCursor>,
  nanoseconds = cursor.lastBootNs,
) {
  return reduceCleanupCursor(
    cursor,
    { type: "latch", cause: "normal" },
    clock(nanoseconds),
  );
}

function settle(
  cursor: ReturnType<typeof createCleanupCursor>,
  operation: string,
  result: Readonly<Record<string, unknown>>,
  id?: string,
  nanoseconds = cursor.lastBootNs,
): ReturnType<typeof createCleanupCursor> {
  const token = createOwnedChildToken();
  const active = reduceCleanupCursor(cursor, {
    type: "begin-operation",
    operation,
    token,
    ...(id === undefined ? {} : { id }),
  }, clock(nanoseconds));
  return finishActive(active, result, nanoseconds);
}

function finishActive(
  cursor: ReturnType<typeof createCleanupCursor>,
  result: Readonly<Record<string, unknown>>,
  nanoseconds = cursor.lastBootNs,
): ReturnType<typeof createCleanupCursor> {
  const token = cursor.active?.token;
  const recorded = reduceCleanupCursor(
    cursor,
    { type: "record-result", token, ...result },
    clock(nanoseconds),
  );
  if (!recorded.active?.requiresReap) {
    return reduceCleanupCursor(recorded, { type: "advance" }, clock(nanoseconds));
  }
  const reaped = reduceCleanupCursor(
    recorded,
    { type: "observe-reap", token },
    clock(nanoseconds),
  );
  return reduceCleanupCursor(reaped, { type: "advance" }, clock(nanoseconds));
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
    expect(dockerEnvironment(invocation, invocationDirectory)).toEqual({
      HOME: `${invocationDirectory}/docker/home`,
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    });
    expect(dockerPrefix(invocation, invocationDirectory)).toEqual([
      "/usr/bin/docker",
      "--host",
      "unix:///var/run/docker.sock",
      "--config",
      `${invocationDirectory}/docker/config`,
    ]);
    expect(() =>
      dockerEnvironment(invocation, `/tmp/not-the-prefix-${invocation}`),
    ).toThrow("WP-201 invocation path identity mismatch");
    expect(() =>
      dockerPrefix("0".repeat(64), invocationDirectory),
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
    const cursor = cleanupCursor([id, id]);
    expect(cursor.ids).toEqual([{ id, state: "remove-1" }]);

    const afterFirstRemove = advanceIdCleanup(cursor.ids[0], "remove-1", "ambiguous");
    expect(afterFirstRemove.state).toBe("absence-1");
    const afterFirstProbe = advanceIdCleanup(afterFirstRemove, "absence-1", "present");
    expect(afterFirstProbe.state).toBe("remove-2");
    const afterSecondRemove = advanceIdCleanup(afterFirstProbe, "remove-2", "error");
    expect(afterSecondRemove.state).toBe("absence-2");
    const failed = advanceIdCleanup(afterSecondRemove, "absence-2", "ambiguous");
    expect(failed.state).toBe("failed");
    expect(() => advanceIdCleanup(failed, "remove-1", "removed")).toThrow(
      "cleanup operation replay or reorder",
    );
  });

  it("requires branded monotone boot time and the exact 160-second reserve", () => {
    expect(() =>
      createCleanupCursor({
        ids: [],
        activeDeadlineNs,
        hardDeadlineNs: hardDeadlineNs - 1n,
        createIssued: false,
        watcherReady: true,
        sample: clock(0n),
      }),
    ).toThrow("invalid cleanup deadline relation");

    const initial = cleanupCursor();
    expect(() =>
      reduceCleanupCursor(
        initial,
        { type: "latch", cause: "signal" },
        { nanoseconds: 1n },
      ),
    ).toThrow("unbranded CLOCK_BOOTTIME sample");
    const later = reduceCleanupCursor(
      initial,
      { type: "latch", cause: "signal" },
      clock(2n),
    );
    expect(() =>
      reduceCleanupCursor(later, { type: "latch", cause: "signal" }, clock(1n)),
    ).toThrow("CLOCK_BOOTTIME regressed");
    expect(() =>
      reduceCleanupCursor(
        initial,
        {
          type: "begin-operation",
          operation: "preliminary-census",
          token: createOwnedChildToken(),
        },
        clock(1n),
      ),
    ).toThrow("cleanup operation before revocation latch");
    expect(() =>
      reduceCleanupCursor(
        initial,
        { type: "latch", cause: "normal" },
        clock(activeDeadlineNs),
      ),
    ).toThrow("normal cleanup after active deadline");
  });

  it("enforces create settlement at one nanosecond before but not at its cap", () => {
    const id = "b".repeat(64);
    expect(() =>
      reduceCleanupCursor(
        cleanupCursor(),
        {
          type: "begin-child",
          origin: "create",
          operation: "create",
          token: createOwnedChildToken(),
        },
        clock(activeDeadlineNs),
      ),
    ).toThrow("active operation deadline reached");
    const token = createOwnedChildToken();
    const begun = reduceCleanupCursor(
      cleanupCursor(),
      { type: "begin-child", origin: "create", operation: "create", token },
      clock(activeDeadlineNs - 1n),
    );
    const latched = reduceCleanupCursor(
      begun,
      { type: "latch", cause: "deadline" },
      clock(activeDeadlineNs),
    );
    expect(latched.active?.window).toMatchObject({
      kind: "create",
      normalEndNs: activeDeadlineNs + 5n * secondNs,
      termEndNs: activeDeadlineNs + 10n * secondNs,
      endNs: activeDeadlineNs + 15n * secondNs,
      reservedSuffixNs: 145n * secondNs,
    });

    const termed = reduceCleanupCursor(
      latched,
      { type: "advance-child-stage", token, stage: "term" },
      clock(activeDeadlineNs + 5n * secondNs),
    );
    const killed = reduceCleanupCursor(
      termed,
      { type: "advance-child-stage", token, stage: "kill" },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    let accepted = reduceCleanupCursor(
      killed,
      { type: "record-result", token: latched.active?.token, outcome: "created", id },
      clock(activeDeadlineNs + 15n * secondNs - 1n),
    );
    accepted = reduceCleanupCursor(
      accepted,
      { type: "observe-reap", token },
      clock(activeDeadlineNs + 15n * secondNs - 1n),
    );
    const advanced = reduceCleanupCursor(
      accepted,
      { type: "advance" },
      clock(activeDeadlineNs + 15n * secondNs - 1n),
    );
    expect(advanced).toMatchObject({
      phase: "initial-ids",
      create: { settled: true, responseId: id, recovery: "unneeded" },
      ids: [{ id, state: "remove-1" }],
    });
    expect(() =>
      reduceCleanupCursor(
        killed,
        { type: "record-result", token: latched.active?.token, outcome: "created", id },
        clock(activeDeadlineNs + 15n * secondNs),
      ),
    ).toThrow("cleanup operation deadline reached");
    expect(() =>
      reduceCleanupCursor(
        killed,
        { type: "expire-active", token: latched.active?.token },
        clock(activeDeadlineNs + 15n * secondNs - 1n),
      ),
    ).toThrow("cleanup operation has not reached its cap");
    let expired = reduceCleanupCursor(
      killed,
      { type: "expire-active", token: latched.active?.token },
      clock(activeDeadlineNs + 15n * secondNs),
    );
    expect(expired).toMatchObject({
      failed: true,
      active: { stage: "kill", capReached: true, reaped: false, result: null },
    });
    expect(() =>
      reduceCleanupCursor(
        expired,
        { type: "advance" },
        clock(activeDeadlineNs + 15n * secondNs),
      ),
    ).toThrow("cleanup operation child is not reaped");
    expired = reduceCleanupCursor(
      expired,
      { type: "observe-reap", token },
      clock(activeDeadlineNs + 15n * secondNs),
    );
    expect(
      reduceCleanupCursor(
        expired,
        { type: "advance" },
        clock(activeDeadlineNs + 15n * secondNs),
      ).phase,
    ).toBe("name-recovery");
  });

  it("preserves parsed create, other, and cleanup results across latch without replay", () => {
    const createId = "c".repeat(64);
    const createToken = createOwnedChildToken();
    let create = reduceCleanupCursor(
      cleanupCursor(),
      { type: "begin-child", origin: "create", operation: "create", token: createToken },
      clock(1n),
    );
    create = reduceCleanupCursor(
      create,
      { type: "record-result", token: create.active?.token, outcome: "created", id: createId },
      clock(2n),
    );
    create = reduceCleanupCursor(
      create,
      { type: "latch", cause: "signal" },
      clock(3n),
    );
    expect(create.active?.result).toEqual({ outcome: "created", id: createId });
    create = reduceCleanupCursor(
      create,
      { type: "observe-reap", token: createToken },
      clock(3n),
    );
    create = reduceCleanupCursor(create, { type: "advance" }, clock(3n));
    expect(create.ids).toEqual([{ id: createId, state: "remove-1" }]);
    expect(() =>
      reduceCleanupCursor(
        create,
        {
          type: "begin-child",
          origin: "create",
          operation: "create",
          token: createOwnedChildToken(),
        },
        clock(4n),
      ),
    ).toThrow("child start after cleanup latch");

    let other = reduceCleanupCursor(
      cleanupCursor(),
      {
        type: "begin-child",
        origin: "other",
        operation: "start-attach",
        token: createOwnedChildToken(),
      },
      clock(1n),
    );
    other = reduceCleanupCursor(
      other,
      { type: "record-result", token: other.active?.token, outcome: "complete" },
      clock(2n),
    );
    other = reduceCleanupCursor(
      other,
      { type: "latch", cause: "signal" },
      clock(3n),
    );
    expect(other).toMatchObject({
      sharedSlot: { state: "claimed", owner: "active-child" },
      active: { result: { outcome: "complete" }, settledByShared: true },
    });
    other = reduceCleanupCursor(
      other,
      { type: "observe-reap", token: other.active?.token },
      clock(3n),
    );
    other = reduceCleanupCursor(other, { type: "advance" }, clock(3n));
    expect(other.sharedSlot).toEqual({ state: "spent", owner: "active-child" });

    const cleanupId = "d".repeat(64);
    let cleanup = reduceCleanupCursor(
      enterCleanup(cleanupCursor([cleanupId])),
      {
        type: "begin-operation",
        operation: "remove-1",
        id: cleanupId,
        token: createOwnedChildToken(),
      },
      clock(1n),
    );
    cleanup = reduceCleanupCursor(
      cleanup,
      { type: "record-result", token: cleanup.active?.token, outcome: "error" },
      clock(2n),
    );
    cleanup = reduceCleanupCursor(
      cleanup,
      { type: "latch", cause: "signal" },
      clock(3n),
    );
    expect(cleanup.active?.result).toEqual({ outcome: "error" });
    cleanup = reduceCleanupCursor(
      cleanup,
      { type: "observe-reap", token: cleanup.active?.token },
      clock(3n),
    );
    cleanup = reduceCleanupCursor(cleanup, { type: "advance" }, clock(3n));
    expect(cleanup.ids).toEqual([{ id: cleanupId, state: "absence-1" }]);
    expect(cleanup.sharedSlot).toEqual({ state: "spent", owner: "active-child" });
    expect(() =>
      reduceCleanupCursor(
        cleanup,
        {
          type: "begin-operation",
          operation: "remove-1",
          id: cleanupId,
          token: createOwnedChildToken(),
        },
        clock(4n),
      ),
    ).toThrow("cleanup operation replay or reorder");
  });

  it("assigns the shared slot once to either an active child or name recovery", () => {
    const recoveredId = "e".repeat(64);
    let recovery = enterCleanup(cleanupCursor([], { createIssued: true }));
    recovery = reduceCleanupCursor(
      recovery,
      {
        type: "begin-operation",
        operation: "name-recovery",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(recovery).toMatchObject({
      sharedSlot: { state: "claimed", owner: "name-recovery" },
      active: {
        window: {
          kind: "shared",
          endNs: activeDeadlineNs + 10n * secondNs,
          reservedSuffixNs: 135n * secondNs,
        },
      },
    });
    recovery = reduceCleanupCursor(
      recovery,
      {
        type: "record-result",
        token: recovery.active?.token,
        outcome: "found",
        id: recoveredId,
      },
      clock(activeDeadlineNs + 1n),
    );
    recovery = reduceCleanupCursor(
      recovery,
      { type: "observe-reap", token: recovery.active?.token },
      clock(activeDeadlineNs + 1n),
    );
    recovery = reduceCleanupCursor(
      recovery,
      { type: "advance" },
      clock(activeDeadlineNs + 1n),
    );
    expect(recovery.sharedSlot).toEqual({ state: "spent", owner: "name-recovery" });
    expect(recovery.ids).toEqual([{ id: recoveredId, state: "remove-1" }]);
    expect(() =>
      reduceCleanupCursor(
        recovery,
        {
          type: "begin-operation",
          operation: "name-recovery",
          token: createOwnedChildToken(),
        },
        clock(activeDeadlineNs + 2n),
      ),
    ).toThrow("cleanup operation replay or reorder");
  });

  it("cancels idle name recovery when an event supplies custody first", () => {
    const eventId = "4".repeat(64);
    expect(() =>
      reduceCleanupCursor(
        cleanupCursor([], { createIssued: true }),
        {
          type: "begin-child",
          origin: "other",
          operation: "configuration-inspect",
          token: createOwnedChildToken(),
        },
        clock(1n),
      ),
    ).toThrow("owned child while create recovery is unresolved");
    let cursor = enterCleanup(cleanupCursor([], { createIssued: true }));
    expect(cursor.phase).toBe("name-recovery");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "watcher-event", id: eventId },
      clock(1n),
    );
    expect(cursor).toMatchObject({
      phase: "initial-ids",
      create: { recovery: "unneeded" },
      sharedSlot: { state: "available", owner: null },
      ids: [{ id: eventId, state: "remove-1" }],
    });
    expect(() =>
      reduceCleanupCursor(
        cursor,
        {
          type: "begin-operation",
          operation: "name-recovery",
          token: createOwnedChildToken(),
        },
        clock(2n),
      ),
    ).toThrow("cleanup operation replay or reorder");
  });

  it("binds every result to one child token and rejects token replay", () => {
    const token = createOwnedChildToken();
    let cursor = reduceCleanupCursor(
      enterCleanup(cleanupCursor()),
      { type: "begin-operation", operation: "preliminary-census", token },
      clock(1n),
    );
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "record-result", token: createOwnedChildToken(), rows: [] },
        clock(2n),
      ),
    ).toThrow("owned child result token mismatch");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "record-result", token, rows: [] },
      clock(2n),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token },
      clock(2n),
    );
    cursor = reduceCleanupCursor(cursor, { type: "advance" }, clock(2n));
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "begin-operation", operation: "send-close", token },
        clock(3n),
      ),
    ).toThrow("owned child token replay");
  });

  it("enforces TERM, KILL, cap, and positive reap boundaries", () => {
    const id = "5".repeat(64);
    const token = createOwnedChildToken();
    const begun = reduceCleanupCursor(
      enterCleanup(cleanupCursor([id])),
      { type: "begin-operation", operation: "remove-1", id, token },
      clock(0n),
    );
    expect(() =>
      reduceCleanupCursor(
        begun,
        { type: "advance-child-stage", token, stage: "term" },
        clock(5n * secondNs - 1n),
      ),
    ).toThrow("invalid cleanup TERM transition");
    expect(() =>
      reduceCleanupCursor(
        begun,
        { type: "record-result", token, outcome: "removed" },
        clock(5n * secondNs),
      ),
    ).toThrow("cleanup child missing TERM transition");
    let cursor = reduceCleanupCursor(
      begun,
      { type: "advance-child-stage", token, stage: "term" },
      clock(5n * secondNs),
    );
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "advance-child-stage", token, stage: "kill" },
        clock(7n * secondNs - 1n),
      ),
    ).toThrow("invalid cleanup KILL transition");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token, stage: "kill" },
      clock(7n * secondNs),
    );
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "expire-active", token },
        clock(10n * secondNs - 1n),
      ),
    ).toThrow("cleanup operation has not reached its cap");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "expire-active", token },
      clock(10n * secondNs),
    );
    expect(cursor.active).toMatchObject({
      token,
      stage: "kill",
      capReached: true,
      reaped: false,
      result: null,
    });
    expect(() =>
      reduceCleanupCursor(cursor, { type: "advance" }, clock(10n * secondNs)),
    ).toThrow("cleanup operation child is not reaped");
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "observe-reap", token },
        clock(hardDeadlineNs),
      ),
    ).toThrow("cleanup hard deadline reached");
    expect(cursor.active).toMatchObject({ reaped: false, capReached: true });
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token },
      clock(10n * secondNs),
    );
    cursor = reduceCleanupCursor(cursor, { type: "advance" }, clock(10n * secondNs));
    expect(cursor).toMatchObject({
      failed: true,
      ids: [{ id, state: "absence-1" }],
      active: null,
    });

    const jumpToken = createOwnedChildToken();
    let jumped = reduceCleanupCursor(
      enterCleanup(cleanupCursor([id])),
      { type: "begin-operation", operation: "remove-1", id, token: jumpToken },
      clock(0n),
    );
    jumped = reduceCleanupCursor(
      jumped,
      { type: "advance-child-stage", token: jumpToken, stage: "term" },
      clock(11n * secondNs),
    );
    jumped = reduceCleanupCursor(
      jumped,
      { type: "advance-child-stage", token: jumpToken, stage: "kill" },
      clock(11n * secondNs),
    );
    jumped = reduceCleanupCursor(
      jumped,
      { type: "expire-active", token: jumpToken },
      clock(11n * secondNs),
    );
    jumped = reduceCleanupCursor(
      jumped,
      { type: "observe-reap", token: jumpToken },
      clock(11n * secondNs),
    );
    jumped = reduceCleanupCursor(jumped, { type: "advance" }, clock(11n * secondNs));
    expect(jumped).toMatchObject({
      failed: true,
      ids: [{ id, state: "absence-1" }],
      active: null,
    });
  });

  it("atomically revokes normal dispatch for every ordinary-child failure", () => {
    const ordinaryOperations = [
      "context-name",
      "context-endpoint",
      "api-support",
      "platform-manifest",
      "cached-image",
      "image-pull",
      "configuration-inspect",
      "start-attach",
    ];
    for (const operation of ordinaryOperations) {
      const token = createOwnedChildToken();
      let cursor = reduceCleanupCursor(
        cleanupCursor([], { watcherReady: operation !== "image-pull" }),
        { type: "begin-child", origin: "other", operation, token },
        clock(0n),
      );
      cursor = reduceCleanupCursor(
        cursor,
        { type: "record-result", token, outcome: "error" },
        clock(1n),
      );
      expect(cursor).toMatchObject({
        failed: true,
        revocation: { latched: true, cause: "failure", atNs: 1n },
        sharedSlot: { state: "claimed", owner: "active-child" },
        active: { operation, result: { outcome: "error" }, reaped: false },
      });
      expect(() =>
        reduceCleanupCursor(
          cursor,
          {
            type: "begin-child",
            origin: "other",
            operation: "api-support",
            token: createOwnedChildToken(),
          },
          clock(2n),
        ),
      ).toThrow("child start after cleanup latch");
      cursor = reduceCleanupCursor(
        cursor,
        { type: "observe-reap", token },
        clock(2n),
      );
      cursor = reduceCleanupCursor(cursor, { type: "advance" }, clock(2n));
      expect(cursor).toMatchObject({
        failed: true,
        sharedSlot: { state: "spent", owner: "active-child" },
        active: null,
      });
    }

    const createToken = createOwnedChildToken();
    let create = reduceCleanupCursor(
      cleanupCursor(),
      { type: "begin-child", origin: "create", operation: "create", token: createToken },
      clock(0n),
    );
    create = reduceCleanupCursor(
      create,
      { type: "record-result", token: createToken, outcome: "ambiguous" },
      clock(1n),
    );
    expect(create).toMatchObject({
      failed: true,
      revocation: { latched: true, cause: "failure" },
      active: { window: { kind: "create" }, reaped: false },
    });
    expect(() =>
      reduceCleanupCursor(
        create,
        {
          type: "begin-child",
          origin: "other",
          operation: "configuration-inspect",
          token: createOwnedChildToken(),
        },
        clock(2n),
      ),
    ).toThrow("child start after cleanup latch");
  });

  it("executes both removal attempts and the mandatory final absence branch", () => {
    const id = "6".repeat(64);
    let absent = enterCleanup(cleanupCursor([id]));
    absent = settle(absent, "remove-1", { outcome: "error" }, id);
    absent = settle(absent, "absence-1", { outcome: "present" }, id);
    absent = settle(absent, "remove-2", { outcome: "ambiguous" }, id);
    absent = settle(absent, "absence-2", { outcome: "absent" }, id);
    expect(absent).toMatchObject({
      phase: "preliminary-census",
      ids: [{ id, state: "absent" }],
      failed: false,
    });

    let present = enterCleanup(cleanupCursor([id]));
    present = settle(present, "remove-1", { outcome: "removed" }, id);
    present = settle(present, "absence-1", { outcome: "ambiguous" }, id);
    present = settle(present, "remove-2", { outcome: "removed" }, id);
    present = settle(present, "absence-2", { outcome: "present" }, id);
    expect(present).toMatchObject({
      phase: "preliminary-census",
      ids: [{ id, state: "failed" }],
      failed: true,
    });
    expect(() =>
      reduceCleanupCursor(
        present,
        {
          type: "begin-operation",
          operation: "remove-1",
          id,
          token: createOwnedChildToken(),
        },
        clock(1n),
      ),
    ).toThrow("cleanup operation replay or reorder");
  });

  it("settles a pre-watcher image pull at its cap and continues safe cleanup", () => {
    let cursor = reduceCleanupCursor(
      cleanupCursor([], { watcherReady: false }),
      {
        type: "begin-child",
        origin: "other",
        operation: "image-pull",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs - 1n),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "latch", cause: "deadline" },
      clock(activeDeadlineNs),
    );
    expect(cursor).toMatchObject({
      failed: true,
      phase: "final-census",
      sharedSlot: { state: "claimed", owner: "active-child" },
      watcher: { ready: false, closeSent: false, eofObserved: false, reaped: false },
      active: {
        operation: "image-pull",
        window: { kind: "shared", endNs: activeDeadlineNs + 10n * secondNs },
      },
    });
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token: cursor.active?.token, stage: "term" },
      clock(activeDeadlineNs + 5n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token: cursor.active?.token, stage: "kill" },
      clock(activeDeadlineNs + 7n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "expire-active", token: cursor.active?.token },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "advance" },
        clock(activeDeadlineNs + 10n * secondNs),
      ),
    ).toThrow("cleanup operation child is not reaped");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token: cursor.active?.token },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance" },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    expect(cursor.sharedSlot).toEqual({ state: "spent", owner: "active-child" });
    expect(expectedCleanupOperation(cursor)).toEqual({ operation: "final-census" });
    expect(() =>
      reduceCleanupCursor(
        cursor,
        {
          type: "begin-operation",
          operation: "send-close",
          token: createOwnedChildToken(),
        },
        clock(activeDeadlineNs + 10n * secondNs),
      ),
    ).toThrow("cleanup operation replay or reorder");
    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "final-census",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    cursor = finishActive(cursor, { rows: [] }, activeDeadlineNs + 10n * secondNs);
    expect(cursor.phase).toBe("path-helper");
  });

  it("settles watcher EOF and reap even after CLOSE failure", () => {
    let cursor = settle(
      enterCleanup(cleanupCursor()),
      "preliminary-census",
      { rows: [] },
    );
    cursor = settle(cursor, "send-close", { outcome: "failed" });
    expect(cursor).toMatchObject({
      phase: "watcher",
      failed: true,
      watcher: { closeSent: false, eofObserved: false, reaped: false },
    });
    const token = createOwnedChildToken();
    cursor = reduceCleanupCursor(
      cursor,
      { type: "begin-operation", operation: "settle-watcher", token },
      clock(1n),
    );
    cursor = reduceCleanupCursor(cursor, { type: "watcher-eof" }, clock(2n));
    cursor = reduceCleanupCursor(
      cursor,
      { type: "record-result", token, outcome: "failed" },
      clock(2n),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token },
      clock(2n),
    );
    cursor = reduceCleanupCursor(cursor, { type: "advance" }, clock(2n));
    expect(cursor).toMatchObject({
      phase: "final-census",
      failed: true,
      watcher: { closeSent: false, eofObserved: true, reaped: true },
    });

    let expired = settle(
      enterCleanup(cleanupCursor()),
      "preliminary-census",
      { rows: [] },
    );
    expired = settle(expired, "send-close", { outcome: "sent" });
    const expiryToken = createOwnedChildToken();
    expired = reduceCleanupCursor(
      expired,
      { type: "begin-operation", operation: "settle-watcher", token: expiryToken },
      clock(0n),
    );
    expired = reduceCleanupCursor(
      expired,
      { type: "advance-child-stage", token: expiryToken, stage: "term" },
      clock(5n * secondNs),
    );
    expired = reduceCleanupCursor(
      expired,
      { type: "advance-child-stage", token: expiryToken, stage: "kill" },
      clock(8n * secondNs),
    );
    expired = reduceCleanupCursor(
      expired,
      { type: "expire-active", token: expiryToken },
      clock(10n * secondNs),
    );
    expect(expired.active).toMatchObject({ capReached: true, reaped: false });
    expired = reduceCleanupCursor(
      expired,
      { type: "watcher-eof" },
      clock(10n * secondNs),
    );
    expired = reduceCleanupCursor(
      expired,
      { type: "observe-reap", token: expiryToken },
      clock(10n * secondNs),
    );
    expired = reduceCleanupCursor(
      expired,
      { type: "advance" },
      clock(10n * secondNs),
    );
    expect(expired).toMatchObject({
      phase: "final-census",
      failed: true,
      watcher: { closeSent: true, eofObserved: true, reaped: true },
    });
  });

  it("keeps an expired path-helper child in custody until positive reap", () => {
    let cursor = settle(
      enterCleanup(cleanupCursor([], { watcherReady: false })),
      "final-census",
      { rows: [] },
    );
    const failure = settle(cursor, "path-helper", { outcome: "failed" });
    expect(failure).toMatchObject({ phase: "parent-absence", failed: true });

    const token = createOwnedChildToken();
    cursor = reduceCleanupCursor(
      cursor,
      { type: "begin-operation", operation: "path-helper", token },
      clock(0n),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token, stage: "term" },
      clock(4n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token, stage: "kill" },
      clock(7n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "expire-active", token },
      clock(10n * secondNs),
    );
    expect(cursor).toMatchObject({
      phase: "path-helper",
      failed: true,
      active: { capReached: true, reaped: false, result: null },
    });
    expect(() =>
      reduceCleanupCursor(cursor, { type: "advance" }, clock(10n * secondNs)),
    ).toThrow("cleanup operation child is not reaped");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token },
      clock(10n * secondNs),
    );
    cursor = reduceCleanupCursor(cursor, { type: "advance" }, clock(10n * secondNs));
    expect(cursor).toMatchObject({ phase: "parent-absence", failed: true, active: null });
  });

  it("fails final nonempty census and permits no-event no-create cleanup only", () => {
    let nonempty = enterCleanup(cleanupCursor([], { watcherReady: false }));
    nonempty = settle(nonempty, "final-census", { rows: ["a".repeat(64)] });
    expect(nonempty).toMatchObject({
      phase: "path-helper",
      finalCensus: false,
      failed: true,
    });

    let empty = enterCleanup(cleanupCursor([], { watcherReady: false }));
    empty = settle(empty, "final-census", { rows: [] });
    empty = settle(empty, "path-helper", { outcome: "complete" });
    empty = settle(empty, "parent-absence", { outcome: "absent" });
    expect(empty).toMatchObject({
      phase: "complete",
      failed: false,
      create: { issued: false, responseId: null },
      watcher: { ready: false, eventCount: 0 },
    });
  });

  it("refuses terminal success for a response without its one matching event", () => {
    const id = "d".repeat(64);
    let cursor = enterCleanup(cleanupCursor([id]));
    cursor = settle(cursor, "remove-1", { outcome: "removed" }, id);
    cursor = settle(cursor, "absence-1", { outcome: "absent" }, id);
    cursor = settle(cursor, "preliminary-census", { rows: [] });
    cursor = settle(cursor, "send-close", { outcome: "sent" });
    const watcherToken = createOwnedChildToken();
    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "settle-watcher",
        token: watcherToken,
      },
      clock(1n),
    );
    cursor = reduceCleanupCursor(cursor, { type: "watcher-eof" }, clock(1n));
    cursor = finishActive(cursor, { outcome: "reaped" }, 1n);
    cursor = settle(cursor, "final-census", { rows: [] }, undefined, 1n);
    cursor = settle(cursor, "path-helper", { outcome: "complete" }, undefined, 1n);
    cursor = settle(cursor, "parent-absence", { outcome: "absent" }, undefined, 1n);
    expect(cursor).toMatchObject({
      phase: "complete",
      failed: true,
      create: { issued: true, responseId: id },
      watcher: { eventCount: 0, reaped: true },
    });
  });

  it("treats parent absence as a bounded non-child observation at its cap", () => {
    let cursor = enterCleanup(cleanupCursor([], { watcherReady: false }));
    cursor = settle(cursor, "final-census", { rows: [] });
    cursor = settle(cursor, "path-helper", { outcome: "complete" });
    const token = createOwnedChildToken();
    cursor = reduceCleanupCursor(
      cursor,
      { type: "begin-operation", operation: "parent-absence", token },
      clock(0n),
    );
    expect(cursor.active).toMatchObject({ requiresReap: false, reaped: false });
    cursor = reduceCleanupCursor(
      cursor,
      { type: "expire-active", token },
      clock(5n * secondNs),
    );
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "observe-reap", token },
        clock(5n * secondNs),
      ),
    ).toThrow("no unreaped owned child");
    cursor = reduceCleanupCursor(cursor, { type: "advance" }, clock(5n * secondNs));
    expect(cursor).toMatchObject({
      phase: "complete",
      failed: true,
      parentAbsence: false,
      active: null,
    });
  });

  it("revokes on a pre-create event and fails response/event disagreement", () => {
    const responseId = "b".repeat(64);
    const eventId = "c".repeat(64);
    const premature = reduceCleanupCursor(
      cleanupCursor(),
      { type: "watcher-event", id: eventId },
      clock(1n),
    );
    expect(premature).toMatchObject({
      failed: true,
      revocation: { latched: true, cause: "failure" },
      ids: [],
      watcher: { eventCount: 1, event: { id: eventId } },
    });
    expect(() =>
      reduceCleanupCursor(
        premature,
        {
          type: "begin-child",
          origin: "create",
          operation: "create",
          token: createOwnedChildToken(),
        },
        clock(2n),
      ),
    ).toThrow("child start after cleanup latch");

    const mismatch = reduceCleanupCursor(
      cleanupCursor([responseId]),
      { type: "watcher-event", id: eventId },
      clock(1n),
    );
    expect(mismatch).toMatchObject({
      failed: true,
      create: { responseId },
      watcher: { event: { id: eventId } },
      ids: [
        { id: responseId, state: "remove-1" },
        { id: eventId, state: "remove-1" },
      ],
    });
  });

  it("reserves every ID, watcher, final, path, and scheduling suffix", () => {
    const id = "f".repeat(64);
    let cursor = enterCleanup(cleanupCursor([id]), activeDeadlineNs - 1n);
    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "remove-1",
        id,
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window?.reservedSuffixNs).toBe(125n * secondNs);
    cursor = finishActive(cursor, { outcome: "removed" }, activeDeadlineNs);
    cursor = settle(cursor, "absence-1", { outcome: "absent" }, id, activeDeadlineNs);

    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "preliminary-census",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window?.reservedSuffixNs).toBe(85n * secondNs);
    cursor = finishActive(cursor, { rows: [] }, activeDeadlineNs);

    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "send-close",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window?.reservedSuffixNs).toBe(75n * secondNs);
    cursor = reduceCleanupCursor(
      cursor,
      { type: "watcher-event", id },
      clock(activeDeadlineNs),
    );
    cursor = finishActive(cursor, { outcome: "sent" }, activeDeadlineNs);
    const watcherWindow = cursor.watcher.window;
    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "settle-watcher",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window).toEqual(watcherWindow);
    cursor = reduceCleanupCursor(cursor, { type: "watcher-eof" }, clock(activeDeadlineNs));
    cursor = finishActive(cursor, { outcome: "reaped" }, activeDeadlineNs);

    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "final-census",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window?.reservedSuffixNs).toBe(25n * secondNs);
    cursor = finishActive(cursor, { rows: [] }, activeDeadlineNs);

    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "path-helper",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window?.reservedSuffixNs).toBe(15n * secondNs);
    cursor = finishActive(cursor, { outcome: "complete" }, activeDeadlineNs);

    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "parent-absence",
        token: createOwnedChildToken(),
      },
      clock(activeDeadlineNs),
    );
    expect(cursor.active?.window?.reservedSuffixNs).toBe(10n * secondNs);
    cursor = finishActive(cursor, { outcome: "absent" }, activeDeadlineNs);
    expect(cursor).toMatchObject({
      phase: "complete",
      failed: false,
      create: { issued: true, responseId: id },
      watcher: { eventCount: 1, closeSent: true, eofObserved: true, reaped: true },
      finalCensus: true,
      pathCleanup: true,
      parentAbsence: true,
    });
    expect(expectedCleanupOperation(cursor)).toBeNull();
  });

  it("classifies census rows only from the sole post-launch watcher event", () => {
    const eventId = "7".repeat(64);
    const mismatch = "8".repeat(64);
    let postLaunch = enterCleanup(cleanupCursor([eventId]));
    postLaunch = settle(postLaunch, "remove-1", { outcome: "removed" }, eventId);
    postLaunch = settle(postLaunch, "absence-1", { outcome: "absent" }, eventId);
    postLaunch = reduceCleanupCursor(
      postLaunch,
      {
        type: "begin-operation",
        operation: "preliminary-census",
        token: createOwnedChildToken(),
      },
      clock(1n),
    );
    postLaunch = reduceCleanupCursor(
      postLaunch,
      { type: "watcher-event", id: eventId },
      clock(2n),
    );
    postLaunch = reduceCleanupCursor(
      postLaunch,
      { type: "record-result", token: postLaunch.active?.token, rows: [eventId] },
      clock(3n),
    );
    expect(postLaunch.active?.result).toEqual({
      outcome: "deferred",
      deferredId: eventId,
    });

    let wrong = enterCleanup(cleanupCursor([eventId]));
    wrong = settle(wrong, "remove-1", { outcome: "removed" }, eventId);
    wrong = settle(wrong, "absence-1", { outcome: "absent" }, eventId);
    wrong = reduceCleanupCursor(
      wrong,
      {
        type: "begin-operation",
        operation: "preliminary-census",
        token: createOwnedChildToken(),
      },
      clock(1n),
    );
    wrong = reduceCleanupCursor(
      wrong,
      { type: "watcher-event", id: eventId },
      clock(2n),
    );
    wrong = reduceCleanupCursor(
      wrong,
      { type: "record-result", token: wrong.active?.token, rows: [mismatch] },
      clock(3n),
    );
    expect(wrong.active?.result).toEqual({ outcome: "uncertain", deferredId: null });

    let preLaunch = reduceCleanupCursor(
      cleanupCursor([eventId]),
      { type: "watcher-event", id: eventId },
      clock(1n),
    );
    preLaunch = enterCleanup(preLaunch, 2n);
    preLaunch = settle(preLaunch, "remove-1", { outcome: "removed" }, eventId, 2n);
    preLaunch = settle(preLaunch, "absence-1", { outcome: "absent" }, eventId, 2n);
    preLaunch = reduceCleanupCursor(
      preLaunch,
      {
        type: "begin-operation",
        operation: "preliminary-census",
        token: createOwnedChildToken(),
      },
      clock(3n),
    );
    preLaunch = reduceCleanupCursor(
      preLaunch,
      { type: "record-result", token: preLaunch.active?.token, rows: [eventId] },
      clock(4n),
    );
    expect(preLaunch.active?.result).toEqual({ outcome: "uncertain", deferredId: null });

    const second = reduceCleanupCursor(
      postLaunch,
      { type: "watcher-event", id: mismatch },
      clock(4n),
    );
    expect(second).toMatchObject({ failed: true, watcher: { eventCount: 2 } });
    expect(second.finalIds).toEqual([]);
  });

  it("accepts events only from watcher READY through drained EOF, never after reap", () => {
    const eventId = "9".repeat(64);
    let cursor = settle(
      enterCleanup(cleanupCursor()),
      "preliminary-census",
      { rows: [] },
      undefined,
      1n,
    );
    cursor = settle(cursor, "send-close", { outcome: "sent" }, undefined, 2n);
    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "settle-watcher",
        token: createOwnedChildToken(),
      },
      clock(3n),
    );
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "record-result", token: cursor.active?.token, outcome: "reaped" },
        clock(4n),
      ),
    ).toThrow("watcher reaped before event EOF");

    cursor = reduceCleanupCursor(cursor, { type: "watcher-eof" }, clock(4n));
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "watcher-event", id: eventId },
        clock(5n),
      ),
    ).toThrow("event arrived outside watcher READY-to-EOF interval");
    cursor = reduceCleanupCursor(
      cursor,
      { type: "record-result", token: cursor.active?.token, outcome: "reaped" },
      clock(5n),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token: cursor.active?.token },
      clock(5n),
    );
    expect(cursor.watcher.reaped).toBe(true);
    expect(() =>
      reduceCleanupCursor(
        cursor,
        { type: "watcher-event", id: eventId },
        clock(6n),
      ),
    ).toThrow("event arrived outside watcher READY-to-EOF interval");
  });

  it("never bypasses watcher EOF and reap when CLOSE consumes its cap", () => {
    let cursor = settle(
      enterCleanup(cleanupCursor()),
      "preliminary-census",
      { rows: [] },
      undefined,
      activeDeadlineNs,
    );
    const token = createOwnedChildToken();
    cursor = reduceCleanupCursor(
      cursor,
      { type: "begin-operation", operation: "send-close", token },
      clock(activeDeadlineNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token, stage: "term" },
      clock(activeDeadlineNs + 5n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance-child-stage", token, stage: "kill" },
      clock(activeDeadlineNs + 8n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "record-result", token, outcome: "sent" },
      clock(activeDeadlineNs + 10n * secondNs - 1n),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance" },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    expect(cursor).toMatchObject({
      phase: "watcher",
      failed: true,
      watcher: { closeSent: true, eofObserved: false, reaped: false },
    });
    expect(expectedCleanupOperation(cursor)).toEqual({ operation: "settle-watcher" });
    const watcherToken = createOwnedChildToken();
    cursor = reduceCleanupCursor(
      cursor,
      {
        type: "begin-operation",
        operation: "settle-watcher",
        token: watcherToken,
      },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "expire-active", token: watcherToken },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "watcher-eof" },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "observe-reap", token: watcherToken },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    cursor = reduceCleanupCursor(
      cursor,
      { type: "advance" },
      clock(activeDeadlineNs + 10n * secondNs),
    );
    expect(cursor).toMatchObject({
      phase: "final-census",
      failed: true,
      watcher: { eofObserved: true, reaped: true, capReached: true },
    });
  });
});
