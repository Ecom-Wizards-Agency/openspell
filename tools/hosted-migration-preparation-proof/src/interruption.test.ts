import { describe, expect, it } from "vitest";

import type { CUT_CASES } from "../scripts/proof-engine.mjs";

import {
  ACQUISITION_ROLE,
  CLEANUP_RESERVE_NS,
  CUT_ACTIVE_NS,
  CUT_INNER_CLEANUP_NS,
  CUT_OUTER_RESERVE_NS,
  CUT_POST_REAP_NS,
  FAILED_CUT_TEARDOWN_NS,
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
  createCutHarnessReapReceipt,
  createCutSupervisorCursor,
  createOwnedChildToken,
  createPreReadyWatcherCustody,
  dockerEnvironment,
  dockerOperationArguments,
  dockerPrefix,
  expectedCleanupOperation,
  expectedCutSupervisorOperation,
  invocationRecord,
  proofContainerName,
  proofCreateArguments,
  classifyDockerCachedImage,
  classifyDockerExactName,
  parseCutAcceptedIdFrame,
  parseCutAuditStream,
  parseCutIdentityFrame,
  parseCutTerminalResult,
  parseDockerAbsence,
  parseDockerApiSupport,
  parseDockerContainerInspection,
  parseDockerContextEndpoint,
  parseDockerContextName,
  parseDockerCreatedId,
  parseDockerEventIdFrame,
  parseDockerEventReadyFrame,
  parseDockerLabelCensus,
  parseDockerPlatformManifest,
  parseDockerRemove,
  reduceCutSupervisorCursor,
  reduceCleanupCursor,
  reducePreReadyWatcherCustody,
  requireCutIdentityAgreement,
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

function dockerResult(status: number, stdout: string | Buffer, stderr: string | Buffer = "") {
  return {
    status,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"),
    stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr, "utf8"),
  };
}

function inspectionHostConfig(kind: "acquisition" | "proof") {
  const proof = kind === "proof";
  const mounts = proof
    ? [
        ["source", "/input/source", true],
        ["acquisition/vendor", "/input/vendor", true],
        ["acquisition/toolchain", "/input/toolchain", true],
        ["acquisition/vendor-ledger.v1", "/input/vendor-ledger.v1", false],
        ["control/proof.sh", "/input/control.sh", false],
        ["control/hostname", "/etc/hostname", false],
        ["control/hosts", "/etc/hosts", false],
        ["control/resolv.conf", "/etc/resolv.conf", false],
      ] as const
    : [
        ["source", "/input/source", true],
        ["control/acquisition.sh", "/input/control.sh", false],
      ] as const;
  return {
    Binds: null,
    ContainerIDFile: "",
    LogConfig: { Type: "none", Config: {} },
    NetworkMode: proof ? "none" : "bridge",
    PortBindings: {},
    RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    AutoRemove: false,
    VolumeDriver: "",
    VolumesFrom: null,
    ConsoleSize: [0, 0],
    CapAdd: null,
    CapDrop: ["ALL"],
    CgroupnsMode: "private",
    Dns: null,
    DnsOptions: [],
    DnsSearch: [],
    ExtraHosts: null,
    GroupAdd: null,
    IpcMode: "private",
    Cgroup: "",
    Links: null,
    OomScoreAdj: 0,
    PidMode: "",
    Privileged: false,
    PublishAllPorts: false,
    ReadonlyRootfs: true,
    SecurityOpt: ["no-new-privileges", "seccomp=builtin", "apparmor=docker-default"],
    Tmpfs: proof
      ? {
          "/cargo": "rw,nodev,nosuid,noexec,size=268435456,mode=0700",
          "/target": "rw,nodev,nosuid,exec,size=4294967296,mode=0700",
          "/tmp": "rw,nodev,nosuid,noexec,size=1073741824,mode=0700",
          "/fixtures": "rw,nodev,nosuid,noexec,size=2147483648,mode=0700",
          "/wp201-home": "rw,nodev,nosuid,noexec,size=16777216,mode=0700",
        }
      : {
          "/output": "rw,nodev,nosuid,exec,size=1073741824,mode=0700,uid=123,gid=456",
          "/tmp": "rw,nodev,nosuid,noexec,size=1073741824,mode=0700,uid=123,gid=456",
          "/wp201-home": "rw,nodev,nosuid,noexec,size=16777216,mode=0700,uid=123,gid=456",
        },
    UTSMode: "",
    UsernsMode: "host",
    ShmSize: proof ? 2_147_483_648 : 268_435_456,
    Runtime: "runc",
    Isolation: "",
    CpuShares: 0,
    Memory: proof ? 6_442_450_944 : 2_147_483_648,
    NanoCpus: proof ? 4_000_000_000 : 2_000_000_000,
    CgroupParent: "",
    BlkioWeight: 0,
    BlkioWeightDevice: [],
    BlkioDeviceReadBps: [],
    BlkioDeviceWriteBps: [],
    BlkioDeviceReadIOps: [],
    BlkioDeviceWriteIOps: [],
    CpuPeriod: 0,
    CpuQuota: 0,
    CpuRealtimePeriod: 0,
    CpuRealtimeRuntime: 0,
    CpusetCpus: "",
    CpusetMems: "",
    Devices: [],
    DeviceCgroupRules: null,
    DeviceRequests: null,
    MemoryReservation: 0,
    MemorySwap: proof ? 6_442_450_944 : 2_147_483_648,
    MemorySwappiness: null,
    Init: false,
    OomKillDisable: false,
    PidsLimit: proof ? 512 : 128,
    Ulimits: proof
      ? [
          { Name: "nofile", Hard: 1_024, Soft: 1_024 },
          { Name: "nproc", Hard: 512, Soft: 512 },
        ]
      : [{ Name: "nofile", Hard: 1_024, Soft: 1_024 }],
    CpuCount: 0,
    CpuPercent: 0,
    IOMaximumIOps: 0,
    IOMaximumBandwidth: 0,
    Mounts: mounts.map(([source, target, recursive]) => ({
      Type: "bind",
      Source: `${invocationDirectory}/${source}`,
      Target: target,
      ReadOnly: true,
      BindOptions: recursive
        ? { Propagation: "rprivate", ReadOnlyForceRecursive: true }
        : { Propagation: "rprivate" },
    })),
    MaskedPaths: [
      "/proc/acpi",
      "/proc/asound",
      "/proc/interrupts",
      "/proc/kcore",
      "/proc/keys",
      "/proc/latency_stats",
      "/proc/sched_debug",
      "/proc/scsi",
      "/proc/timer_list",
      "/proc/timer_stats",
      "/sys/devices/virtual/powercap",
      "/sys/firmware",
    ],
    ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
  };
}

function jsonResult(value: unknown) {
  return dockerResult(0, `${JSON.stringify(value)}\n`);
}

function dockerReceiptSource(operation: string, token = createOwnedChildToken()) {
  return { token, operation };
}

const indexDigest = IMAGE.slice(IMAGE.lastIndexOf("@") + 1);
const manifestDigest =
  "sha256:408fe88047cef61a2087653b0c5255fa51c0f2d6d94ddedd7a2562a9b91a46f6";
const configDigest =
  "sha256:897e260d0a1a5a5146433bdb73f62bd84f5f47e846d3485e5f70f63912b5917d";
const layerDescriptors = [
  ["sha256:3af9207d37990175f61d5ce9faa0c7373ffcd2d6da1b6ba0a9ca9d61f8f47cc9", 48_497_091],
  ["sha256:6b02178232c403d8a6d5b460ad955daba177c38e178ed7dd417e5c4d748e948d", 24_044_139],
  ["sha256:c5a4625b533197abb25ea2a32be06c59c984d97c3c2dc9952e0b76f2e81ee0d2", 64_408_267],
  ["sha256:d32ed818f20fae825717c40dbc77cd4ed4bcefad6ba95a83f8c4f3c1f8631c31", 211_659_733],
  ["sha256:a6c1a23a6280781f0cf3b6b3a43fc59462763953c4285dd4addc7d4963cc923f", 217_852_857],
] as const;
const diffIds = [
  "sha256:63ecca237e30aca8ae79232ae01dddab7d8b42302f654f343f7cc7ddae60d57c",
  "sha256:e62aadfda549a23e76f5bb43a9a5c652f9e7312aba9edf5c1411f7d0aed54eed",
  "sha256:3acdb7d9b7ebcd7f62d99a996099a57b8367821f4d9a3f4b52239934425a7b98",
  "sha256:b33c96ad984974239102a1fe15e6427a3510f13aa320227b371c10bb40063356",
  "sha256:0bfd9a65e13cc2726159178398201f52cd4e5bd1c187584f6953c839438af7d5",
] as const;

function acquisitionInspection(state: "created" | "exited") {
  const create = acquisitionCreateArguments({
    invocation,
    invocationDirectory,
    uid: 123,
    gid: 456,
  });
  return {
    Id: "a".repeat(64),
    Name: `/openspell-wp201-${invocation}-acquisition`,
    Image: configDigest,
    RestartCount: 0,
    Config: {
      Hostname: "wp201-acquisition",
      Domainname: "",
      User: "123:456",
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      Image: IMAGE,
      Volumes: null,
      Labels: {
        "com.openspell.wp201.invocation": invocation,
        "com.openspell.wp201.role": ACQUISITION_ROLE,
        "org.opencontainers.image.source": "https://github.com/rust-lang/docker-rust",
      },
      Entrypoint: ["/usr/bin/env"],
      Cmd: create.slice(create.indexOf(IMAGE) + 1),
      Env: [
        "PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "RUSTUP_HOME=/usr/local/rustup",
        "CARGO_HOME=/usr/local/cargo",
        "RUST_VERSION=1.97.1",
      ],
      WorkingDir: "/tmp",
    },
    HostConfig: inspectionHostConfig("acquisition"),
    State: {
      Status: state,
      Running: false,
      Restarting: false,
      Paused: false,
      Dead: false,
      OOMKilled: false,
      ExitCode: 0,
      Error: "",
      Pid: 0,
    },
  };
}

function proofInspection() {
  const create = proofCreateArguments({
    invocation,
    invocationDirectory,
    rowId: "root-fmt",
    ledgerSha256,
  });
  return {
    Id: "b".repeat(64),
    Name: `/openspell-wp201-${invocation}-proof-root-fmt`,
    Image: configDigest,
    RestartCount: 0,
    Config: {
      Hostname: "wp201-proof",
      Domainname: "",
      User: "0:0",
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: true,
      StdinOnce: true,
      Image: IMAGE,
      Volumes: null,
      Labels: {
        "com.openspell.wp201.invocation": invocation,
        "com.openspell.wp201.role": PROOF_ROLE,
        "org.opencontainers.image.source": "https://github.com/rust-lang/docker-rust",
      },
      Entrypoint: ["/usr/bin/env"],
      Cmd: create.slice(create.indexOf(IMAGE) + 1),
      Env: [
        "PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "RUSTUP_HOME=/usr/local/rustup",
        "CARGO_HOME=/usr/local/cargo",
        "RUST_VERSION=1.97.1",
      ],
      WorkingDir: "/tmp",
    },
    HostConfig: inspectionHostConfig("proof"),
    State: {
      Status: "created",
      Running: false,
      Restarting: false,
      Paused: false,
      Dead: false,
      OOMKilled: false,
      ExitCode: 0,
      Error: "",
      Pid: 0,
    },
  };
}

function parsedCutIdentity(cutCase: (typeof CUT_CASES)[number], token: object) {
  return parseCutIdentityFrame(
    Buffer.from(
      [
        "openspell.wp201.real-cut-identity.v2",
        cutCase,
        invocation,
        "tmp",
        "10",
        "20",
        "30",
        ledgerSha256,
        "40",
        "50",
        "",
      ].join("\n"),
    ),
    token,
  );
}

function parsedCutAudit(token: object) {
  const prefix = ["openspell", "wp201", "real-cut"].join(".");
  return parseCutAuditStream(
    Buffer.from(
      `${prefix}-audit-open.v1\n` +
        `${prefix}-signal-latched.v1\nSIGTERM\n` +
        `${prefix}-audit-close.v1\n`,
    ),
    token,
  );
}

function cutReapReceipt(
  cutCase: (typeof CUT_CASES)[number],
  acceptedId: string | null,
  token: object,
  valid = true,
) {
  return createCutHarnessReapReceipt({
    cutCase,
    token,
    terminal: valid
      ? parseCutTerminalResult({
          status: 73,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("openspell.wp201.interrupted-before-start.v1\n"),
        }, token)
      : null,
    accepted: parseCutAcceptedIdFrame(
      Buffer.from(
        `openspell.wp201.real-cut-accepted-id.v1\n${acceptedId ?? "none"}\n`,
      ),
      cutCase,
      token,
    ),
    identity: valid ? parsedCutIdentity(cutCase, token) : null,
    audit: valid ? parsedCutAudit(token) : null,
    pipesEof: true,
    groupAbsent: true,
  });
}

function exactProofNameAbsent(token: object, operation: string) {
  return classifyDockerExactName(
    dockerResult(
      1,
      "[]\n",
      `Error response from daemon: No such container: openspell-wp201-${invocation}-proof-root-fmt\n`,
    ),
    { kind: "proof", invocation, rowId: "root-fmt" },
    { token, operation },
  );
}

function inspectedProof(id: string, token: object, operation: string) {
  return parseDockerContainerInspection(jsonResult([{ ...proofInspection(), Id: id }]), {
    kind: "proof",
    invocation,
    invocationDirectory,
    rowId: "root-fmt",
    ledgerSha256,
    localImageId: configDigest,
    state: "created",
  }, { token, operation });
}

describe("WP-201 strict Docker and interruption protocols", () => {
  it("accepts only the frozen context, endpoint, API tuple, and manifest", () => {
    expect(parseDockerContextName(dockerResult(0, "default\n"))).toBe("default");
    expect(parseDockerContextEndpoint(jsonResult("unix:///var/run/docker.sock"))).toBe(
      "unix:///var/run/docker.sock",
    );
    expect(
      parseDockerApiSupport(
        jsonResult({
          Client: {
            Platform: { Name: "Docker Engine - Community" },
            Version: "29.7.2",
            ApiVersion: "1.55",
            DefaultAPIVersion: "1.55",
            GitCommit: "a7dcaa6",
            GoVersion: "go1.26.5",
            Os: "linux",
            Arch: "amd64",
            BuildTime: "Wed Aug  5 18:28:40 2026",
            Context: "default",
          },
          Server: { ApiVersion: "1.49" },
        }),
      ),
    ).toEqual({ clientApiVersion: "1.55", serverApiVersion: "1.49" });
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: 4_547,
      },
      layers: layerDescriptors.map(([digest, size]) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest,
        size,
      })),
    };
    expect(parseDockerPlatformManifest(jsonResult(manifest))).toEqual({
      manifestDigest,
      configDigest,
    });

    expect(() => parseDockerContextName(dockerResult(0, "default\nextra"))).toThrow();
    expect(() => parseDockerContextEndpoint(dockerResult(0, '"tcp://peer"\n'))).toThrow();
    expect(() =>
      parseDockerContextEndpoint(dockerResult(0, ' "unix:///var/run/docker.sock"\n')),
    ).toThrow("endpoint mismatch");
    expect(() =>
      parseDockerContextEndpoint(
        dockerResult(0, `${String.raw`"unix:\/\/\/var\/run\/docker.sock"`}\n`),
      ),
    ).toThrow("endpoint mismatch");
    expect(() =>
      parseDockerApiSupport(
        dockerResult(0, '{"Client":{"ApiVersion":"1.55","ApiVersion":"1.55"},"Server":{}}\n'),
      ),
    ).toThrow("JSON duplicate key");
    expect(() =>
      parseDockerPlatformManifest(jsonResult({ ...manifest, layers: [...manifest.layers].reverse() })),
    ).toThrow();
    expect(() =>
      parseDockerApiSupport(
        jsonResult({
          Client: {
            Platform: { Name: "Docker Engine - Community" },
            Version: "29.7.2",
            ApiVersion: "1.55",
            DefaultAPIVersion: "1.55",
            GitCommit: "a7dcaa6",
            GoVersion: "go1.26.5",
            Os: "linux",
            Arch: "amd64",
            BuildTime: "Wed Aug  5 18:28:40 2026",
            Context: "default",
          },
          Server: { ApiVersion: `1.${"9".repeat(100)}` },
        }),
      ),
    ).toThrow("API is too old");
  });

  it("classifies the two image stores and only the frozen cache miss", () => {
    const image = {
      Id: configDigest,
      RepoDigests: [`rust@${indexDigest}`],
      Os: "linux",
      Architecture: "amd64",
      RootFS: { Type: "layers", Layers: diffIds },
      Config: {
        Env: [
          "PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "RUSTUP_HOME=/usr/local/rustup",
          "CARGO_HOME=/usr/local/cargo",
          "RUST_VERSION=1.97.1",
        ],
        Cmd: ["bash"],
        Labels: {
          "org.opencontainers.image.source": "https://github.com/rust-lang/docker-rust",
        },
      },
    };
    expect(classifyDockerCachedImage(jsonResult([image]))).toEqual({
      outcome: "present",
      localImageId: configDigest,
      store: "classic",
    });
    expect(
      classifyDockerCachedImage(
        jsonResult([
          {
            ...image,
            Id: manifestDigest,
            Descriptor: {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              digest: manifestDigest,
              size: 1_940,
              platform: { architecture: "amd64", os: "linux" },
            },
          },
        ]),
      ),
    ).toEqual({ outcome: "present", localImageId: manifestDigest, store: "containerd" });
    expect(
      classifyDockerCachedImage(
        dockerResult(
          1,
          "[]\n",
          `Error response from daemon: No such image: rust:1.97.1-bookworm@${indexDigest}\n`,
        ),
      ),
    ).toEqual({ outcome: "missing" });
    expect(() => classifyDockerCachedImage(jsonResult([{ ...image, Id: indexDigest }]))).toThrow();
  });

  it("parses exact create, remove, absence, census, name, and container-state results", () => {
    const id = "a".repeat(64);
    expect(parseDockerCreatedId(dockerResult(0, `${id}\n`))).toBe(id);
    expect(
      parseDockerRemove(dockerResult(0, `${id}\n`), id, dockerReceiptSource("remove")),
    ).toMatchObject({ outcome: "removed", id, operation: "remove" });
    expect(
      parseDockerAbsence(
        dockerResult(1, "[]\n", `Error response from daemon: No such container: ${id}\n`),
        id,
        dockerReceiptSource("absence"),
      ),
    ).toMatchObject({ outcome: "absent", id, operation: "absence" });
    expect(
      parseDockerLabelCensus(
        dockerResult(0, `${id}\n${"b".repeat(64)}\n`),
        invocation,
        dockerReceiptSource("label-census"),
      ),
    ).toMatchObject({
      invocation,
      operation: "label-census",
      ids: [id, "b".repeat(64)],
    });
    expect(
      classifyDockerExactName(
        dockerResult(
          1,
          "[]\n",
          `Error response from daemon: No such container: openspell-wp201-${invocation}-acquisition\n`,
        ),
        { kind: "acquisition", invocation },
        dockerReceiptSource("exact-name-acquisition"),
      ),
    ).toMatchObject({ outcome: "absent", kind: "acquisition", invocation });
    expect(
      classifyDockerExactName(jsonResult([acquisitionInspection("created")]), {
        kind: "acquisition",
        invocation,
      }, dockerReceiptSource("exact-name-acquisition")),
    ).toMatchObject({ outcome: "present", id, kind: "acquisition", invocation });
    expect(
      parseDockerContainerInspection(jsonResult([acquisitionInspection("created")]), {
        kind: "acquisition",
        invocation,
        invocationDirectory,
        uid: 123,
        gid: 456,
        localImageId: configDigest,
        state: "created",
      }, dockerReceiptSource("configuration-inspect")),
    ).toMatchObject({ id, store: "classic", state: "created", kind: "acquisition" });
    expect(
      parseDockerContainerInspection(jsonResult([acquisitionInspection("exited")]), {
        kind: "acquisition",
        invocation,
        invocationDirectory,
        uid: 123,
        gid: 456,
        localImageId: configDigest,
        state: "exited-zero",
      }, dockerReceiptSource("configuration-inspect")),
    ).toMatchObject({ id, store: "classic", state: "exited-zero", kind: "acquisition" });
    expect(
      parseDockerContainerInspection(jsonResult([proofInspection()]), {
        kind: "proof",
        invocation,
        invocationDirectory,
        rowId: "root-fmt",
        ledgerSha256,
        localImageId: configDigest,
        state: "created",
      }, dockerReceiptSource("configuration-inspect")),
    ).toMatchObject({
      id: "b".repeat(64),
      store: "classic",
      state: "created",
      kind: "proof",
      rowId: "root-fmt",
    });
    const containerdProof = {
      ...proofInspection(),
      Image: indexDigest,
      ImageManifestDescriptor: {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: 1_940,
        platform: { architecture: "amd64", os: "linux" },
      },
    };
    expect(
      parseDockerContainerInspection(jsonResult([containerdProof]), {
        kind: "proof",
        invocation,
        invocationDirectory,
        rowId: "root-fmt",
        ledgerSha256,
        localImageId: manifestDigest,
        state: "created",
      }, dockerReceiptSource("configuration-inspect")),
    ).toMatchObject({
      id: "b".repeat(64),
      store: "containerd",
      state: "created",
      kind: "proof",
      rowId: "root-fmt",
    });

    expect(() => parseDockerCreatedId(dockerResult(0, id))).toThrow();
    expect(() =>
      parseDockerLabelCensus(
        dockerResult(0, `${id}\n${id}\n`),
        invocation,
        dockerReceiptSource("label-census"),
      ),
    ).toThrow();
    expect(() =>
      parseDockerAbsence(
        dockerResult(1, "[]\n", "localized error\n"),
        id,
        dockerReceiptSource("absence"),
      ),
    ).toThrow();
    expect(() =>
      parseDockerContainerInspection(jsonResult([{ ...acquisitionInspection("created"), Name: "/wrong" }]), {
        kind: "acquisition",
        invocation,
        invocationDirectory,
        uid: 123,
        gid: 456,
        localImageId: configDigest,
        state: "created",
      }, dockerReceiptSource("configuration-inspect")),
    ).toThrow("container name mismatch");
  });

  it("rejects missing, weakened, extra, reordered, and duplicate container authority", () => {
    const options = {
      kind: "acquisition" as const,
      invocation,
      invocationDirectory,
      uid: 123,
      gid: 456,
      localImageId: configDigest,
      state: "created" as const,
    };
    const missing = acquisitionInspection("created");
    const missingHost: Record<string, unknown> = { ...missing.HostConfig };
    Reflect.deleteProperty(missingHost, "ReadonlyRootfs");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([{ ...missing, HostConfig: missingHost }]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("HostConfig keys");

    const weakened = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...weakened,
            HostConfig: { ...weakened.HostConfig, ReadonlyRootfs: false },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("ReadonlyRootfs mismatch");

    const unknownHostKey = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...unknownHostKey,
            HostConfig: { ...unknownHostKey.HostConfig, InjectedAuthority: true },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("HostConfig keys");

    for (const hostChange of [
      { VolumesFrom: ["foreign:rw"] },
      { PortBindings: { "80/tcp": [{ HostPort: "8080" }] } },
      { PublishAllPorts: true },
    ]) {
      const authority = acquisitionInspection("created");
      expect(() =>
        parseDockerContainerInspection(
          jsonResult([
            {
              ...authority,
              HostConfig: { ...authority.HostConfig, ...hostChange },
            },
          ]),
          options,
          dockerReceiptSource("configuration-inspect"),
        ),
      ).toThrow();
    }

    const extra = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...extra,
            HostConfig: {
              ...extra.HostConfig,
              Mounts: [
                ...extra.HostConfig.Mounts,
                {
                  Type: "bind",
                  Source: `${invocationDirectory}/source`,
                  Target: "/unexpected",
                  ReadOnly: true,
                  BindOptions: { Propagation: "rprivate", ReadOnlyForceRecursive: true },
                },
              ],
            },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("configured mounts mismatch");

    const reordered = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...reordered,
            HostConfig: {
              ...reordered.HostConfig,
              Mounts: [...reordered.HostConfig.Mounts].reverse(),
            },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("configured mount mismatch");

    const duplicate = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...duplicate,
            HostConfig: {
              ...duplicate.HostConfig,
              Mounts: [duplicate.HostConfig.Mounts[0], duplicate.HostConfig.Mounts[0]],
            },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("configured mount mismatch");

    const wrongTmpfs = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...wrongTmpfs,
            HostConfig: {
              ...wrongTmpfs.HostConfig,
              Tmpfs: { ...wrongTmpfs.HostConfig.Tmpfs, "/tmp": "rw" },
            },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("Tmpfs mismatch");

    const wrongSecurity = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...wrongSecurity,
            HostConfig: { ...wrongSecurity.HostConfig, CapDrop: [] },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("CapDrop");

    const wrongResource = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...wrongResource,
            HostConfig: { ...wrongResource.HostConfig, Memory: 1_073_741_824 },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("Memory mismatch");

    const wrongUlimit = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...wrongUlimit,
            HostConfig: {
              ...wrongUlimit.HostConfig,
              Ulimits: [{ Name: "nofile", Hard: 2_048, Soft: 1_024 }],
            },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("Ulimits mismatch");

    const wrongCommand = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([
          {
            ...wrongCommand,
            Config: { ...wrongCommand.Config, Cmd: [...wrongCommand.Config.Cmd, "extra"] },
          },
        ]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("container command");

    const wrongStore = {
      ...proofInspection(),
      Image: indexDigest,
    };
    expect(() =>
      parseDockerContainerInspection(jsonResult([wrongStore]), {
        kind: "proof",
        invocation,
        invocationDirectory,
        rowId: "root-fmt",
        ledgerSha256,
        localImageId: manifestDigest,
        state: "created",
      }, dockerReceiptSource("configuration-inspect")),
    ).toThrow("container image descriptor");

    const volume = acquisitionInspection("created");
    expect(() =>
      parseDockerContainerInspection(
        jsonResult([{ ...volume, Config: { ...volume.Config, Volumes: { "/data": {} } } }]),
        options,
        dockerReceiptSource("configuration-inspect"),
      ),
    ).toThrow("volumes mismatch");

    for (const extraConfig of [
      { Healthcheck: { Test: ["NONE"] } },
      { MacAddress: "02:42:ac:11:00:02" },
      { StopSignal: "SIGKILL" },
      { UnknownConfigAuthority: true },
    ]) {
      const config = acquisitionInspection("created");
      expect(() =>
        parseDockerContainerInspection(
          jsonResult([{ ...config, Config: { ...config.Config, ...extraConfig } }]),
          options,
          dockerReceiptSource("configuration-inspect"),
        ),
      ).toThrow("container Config keys");
    }
  });

  it("parses and cross-checks READY, event, accepted-ID, identity-v2, and audit frames", () => {
    const id = "c".repeat(64);
    const harnessToken = createOwnedChildToken();
    const auditPrefix = ["openspell", "wp201", "real-cut"].join(".");
    expect(parseDockerEventReadyFrame(Buffer.from("openspell.wp201.docker-event-ready.v1\n"))).toBe(true);
    expect(
      parseDockerEventIdFrame(
        Buffer.from(`openspell.wp201.docker-event-id.v1\n${id}\n`),
      ),
    ).toBe(id);
    expect(
      parseCutAcceptedIdFrame(
        Buffer.from("openspell.wp201.real-cut-accepted-id.v1\nnone\n"),
        "before-issue",
        harnessToken,
      ),
    ).toMatchObject({ token: harnessToken, cutCase: "before-issue", acceptedId: null });
    expect(
      parseCutAcceptedIdFrame(
        Buffer.from(`openspell.wp201.real-cut-accepted-id.v1\n${id}\n`),
        "after-parent-custody-before-start",
        harnessToken,
      ),
    ).toMatchObject({
      token: harnessToken,
      cutCase: "after-parent-custody-before-start",
      acceptedId: id,
    });
    const identityBytes = Buffer.from(
      [
        "openspell.wp201.real-cut-identity.v2",
        "before-issue",
        invocation,
        "tmp",
        "10",
        "20",
        "30",
        ledgerSha256,
        "40",
        "50",
        "",
      ].join("\n"),
    );
    const identity = parseCutIdentityFrame(identityBytes, harnessToken);
    expect(
      requireCutIdentityAgreement(identity, {
        cutCase: "before-issue",
        invocation,
        parent: "tmp",
        directoryDevice: "10",
        directoryInode: "20",
        directoryMountId: "30",
        ledgerSha256,
      }),
    ).toEqual(identity);
    expect(
      parseCutAuditStream(
        Buffer.from(
          `${auditPrefix}-audit-open.v1\n` +
            `${auditPrefix}-signal-latched.v1\nSIGTERM\n` +
            `${auditPrefix}-audit-close.v1\n`,
        ),
        harnessToken,
      ),
    ).toMatchObject({
      token: harnessToken,
      open: true,
      signalLatched: true,
      close: true,
      dispatches: 0,
    });
    expect(
      parseCutTerminalResult({
        status: 73,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("openspell.wp201.interrupted-before-start.v1\n"),
      }, harnessToken),
    ).toMatchObject({ token: harnessToken, status: 73, interruptedBeforeStart: true });

    expect(() => parseDockerEventReadyFrame(Buffer.from("ready\n"))).toThrow();
    expect(() =>
      parseCutAcceptedIdFrame(
        Buffer.from(`openspell.wp201.real-cut-accepted-id.v1\n${id}\n`),
        "before-issue",
        harnessToken,
      ),
    ).toThrow("case mismatch");
    expect(() =>
      parseCutAcceptedIdFrame(Buffer.alloc(129, 0x61), "before-issue", harnessToken),
    ).toThrow("frame cap");
    expect(() => parseCutIdentityFrame(Buffer.alloc(321, 0x61), harnessToken)).toThrow("frame cap");
    expect(() => parseCutAuditStream(Buffer.alloc(513, 0x61), harnessToken)).toThrow("framing");
    expect(() =>
      parseCutAuditStream(
        Buffer.from(
          `${auditPrefix}-audit-open.v1\n` +
            `${auditPrefix}-start-attach.v1\n${PROOF_ROLE}\n${id}\n` +
            `${auditPrefix}-signal-latched.v1\nSIGTERM\n` +
            `${auditPrefix}-audit-close.v1\n`,
        ),
        harnessToken,
      ),
    ).toThrow("terminal sequence mismatch");
    expect(() =>
      parseCutTerminalResult({
        status: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("openspell.wp201.interrupted-before-start.v1\n"),
      }, harnessToken),
    ).toThrow("status mismatch");
    expect(() =>
      parseCutTerminalResult({
        status: 73,
        stdout: Buffer.from("openspell.wp201.bridge-success.v1\n"),
        stderr: Buffer.from("openspell.wp201.interrupted-before-start.v1\n"),
      }, harnessToken),
    ).toThrow("stdout mismatch");
    expect(() =>
      requireCutIdentityAgreement(
        { ...identity },
        {
          cutCase: "before-issue",
          invocation,
          parent: "tmp",
          directoryDevice: "10",
          directoryInode: "20",
          directoryMountId: "30",
          ledgerSha256,
        },
      ),
    ).toThrow("unparsed cut identity");
  });

  it("owns and settles an established watcher before READY without lending its suffix", () => {
    const token = createOwnedChildToken();
    let watcher = createPreReadyWatcherCustody({
      token,
      sample: clock(0n),
      activeDeadlineNs,
      hardDeadlineNs,
    });
    watcher = reducePreReadyWatcherCustody(watcher, { type: "latch" }, clock(activeDeadlineNs));
    expect(watcher).toMatchObject({ phase: "settling", failed: true, stage: "settle" });
    expect(watcher.cleanupWindow?.endNs).toBe(activeDeadlineNs + 10n * secondNs);
    watcher = reducePreReadyWatcherCustody(
      watcher,
      { type: "advance-stage", stage: "term" },
      clock(activeDeadlineNs + 5n * secondNs),
    );
    watcher = reducePreReadyWatcherCustody(
      watcher,
      { type: "advance-stage", stage: "kill" },
      clock(activeDeadlineNs + 7n * secondNs),
    );
    watcher = reducePreReadyWatcherCustody(
      watcher,
      { type: "reap" },
      clock(activeDeadlineNs + 10n * secondNs - 1n),
    );
    expect(watcher).toMatchObject({ phase: "reaped", reaped: true, failed: true });
    expect(() =>
      createPreReadyWatcherCustody({
        token,
        sample: clock(0n),
        activeDeadlineNs,
        hardDeadlineNs,
      }),
    ).toThrow("owned child token replay");
  });

  it("admits harness reap only through parsed receipts and positive EOF/group facts", () => {
    const harnessToken = createOwnedChildToken();
    expect(() =>
      createCutHarnessReapReceipt({
        cutCase: "before-issue",
        token: harnessToken,
        terminal: null,
        accepted: null,
        identity: null,
        audit: null,
        pipesEof: false,
        groupAbsent: true,
      }),
    ).toThrow("not fully reaped");

    const cursor = createCutSupervisorCursor({
      cutCase: "before-issue",
      harnessToken,
      invocation,
      sample: clock(0n),
    });
    expect(() =>
      reduceCutSupervisorCursor(
        cursor,
        {
          type: "harness-reaped",
          valid: false,
          pipesEof: true,
          groupAbsent: true,
          acceptedId: null,
        },
        clock(1n),
      ),
    ).toThrow("harness-reaped transition");
    expect(() =>
      reduceCutSupervisorCursor(
        cursor,
        {
          type: "harness-reaped",
          receipt: {
            cutCase: "before-issue",
            valid: false,
            acceptedId: null,
            pipesEof: true,
            groupAbsent: true,
          },
        },
        clock(1n),
      ),
    ).toThrow("invalid cut harness reap receipt");

    const failedReceipt = cutReapReceipt("before-issue", null, harnessToken, false);
    const failed = reduceCutSupervisorCursor(
      cursor,
      {
        type: "harness-reaped",
        receipt: failedReceipt,
      },
      clock(1n),
    );
    expect(failed).toMatchObject({ harnessReaped: true, phase: "failed-ready", failed: true });
    expect(() =>
      reduceCutSupervisorCursor(
        cursor,
        { type: "harness-reaped", receipt: failedReceipt },
        clock(1n),
      ),
    ).toThrow("invalid cut harness reap receipt");

    const first = createOwnedChildToken();
    const second = createOwnedChildToken();
    expect(() =>
      createCutHarnessReapReceipt({
        cutCase: "before-issue",
        token: first,
        terminal: parseCutTerminalResult(
          {
            status: 73,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("openspell.wp201.interrupted-before-start.v1\n"),
          },
          first,
        ),
        accepted: parseCutAcceptedIdFrame(
          Buffer.from("openspell.wp201.real-cut-accepted-id.v1\nnone\n"),
          "before-issue",
          second,
        ),
        identity: parsedCutIdentity("before-issue", first),
        audit: parsedCutAudit(first),
        pipesEof: true,
        groupAbsent: true,
      }),
    ).toThrow("mixed cut harness process receipts");
  });

  it("freezes the 900+160 inner, 50 post-reap, 900+210 outer, and separate 130 teardown", () => {
    expect(CUT_ACTIVE_NS).toBe(900n * secondNs);
    expect(CUT_INNER_CLEANUP_NS).toBe(160n * secondNs);
    expect(CUT_POST_REAP_NS).toBe(50n * secondNs);
    expect(CUT_OUTER_RESERVE_NS).toBe(210n * secondNs);
    expect(FAILED_CUT_TEARDOWN_NS).toBe(130n * secondNs);

    const id = "d".repeat(64);
    const cutHarnessToken = createOwnedChildToken();
    let cut = createCutSupervisorCursor({
      cutCase: "after-daemon-accept-before-delivery",
      harnessToken: cutHarnessToken,
      invocation,
      sample: clock(0n),
    });
    expect(cut).toMatchObject({
      activeDeadlineNs: 900n * secondNs,
      innerDeadlineNs: 1_060n * secondNs,
      outerDeadlineNs: 1_110n * secondNs,
    });
    cut = reduceCutSupervisorCursor(
      cut,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt(
          "after-daemon-accept-before-delivery",
          id,
          cutHarnessToken,
        ),
      },
      clock(1_060n * secondNs - 1n),
    );
    expect(cut.postReapStartNs).toBe(1_060n * secondNs - 1n);
    expect(cut.postReapDeadlineNs).toBe(1_110n * secondNs - 1n);
    expect(expectedCutSupervisorOperation(cut)).toBe("accepted-id-absence");
    const expected = [
      "accepted-id-absence",
      "exact-name-census",
      "label-census",
      "local-absence",
      "custody",
    ];
    for (const operation of expected) {
      const local = ["local-absence", "custody"].includes(operation);
      cut = reduceCutSupervisorCursor(
        cut,
        local
          ? { type: "begin-slot", operation }
          : {
              type: "begin-slot",
              operation,
              token: createOwnedChildToken(),
              ...(operation === "accepted-id-absence" ? { id } : {}),
            },
        clock(cut.lastBootNs),
      );
      const childToken = cut.active?.token;
      const receipt = operation === "accepted-id-absence"
        ? parseDockerAbsence(
            dockerResult(1, "[]\n", `Error response from daemon: No such container: ${id}\n`),
            id,
            dockerReceiptSource(operation, childToken),
          )
        : operation === "exact-name-census"
          ? exactProofNameAbsent(childToken, operation)
          : operation === "label-census"
            ? parseDockerLabelCensus(
                dockerResult(0, ""),
                invocation,
                dockerReceiptSource(operation, childToken),
              )
            : null;
      cut = reduceCutSupervisorCursor(
        cut,
        local
          ? { type: "complete-slot", operation, outcome: "pass" }
          : {
              type: "complete-slot",
              operation,
              outcome: "pass",
              reaped: true,
              token: cut.active!.token,
              receipt,
              ...(operation === "accepted-id-absence" ? { id } : {}),
            },
        clock(cut.lastBootNs),
      );
    }
    expect(cut).toMatchObject({ phase: "complete", failed: false, slotIndex: 5 });

    const failedHarnessToken = createOwnedChildToken();
    let failed = createCutSupervisorCursor({
      cutCase: "before-issue",
      harnessToken: failedHarnessToken,
      invocation,
      sample: clock(0n),
    });
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt("before-issue", null, failedHarnessToken, false),
      },
      clock(1n),
    );
    failed = reduceCutSupervisorCursor(failed, { type: "begin-failed-teardown" }, clock(2n));
    expect(failed.teardownDeadlineNs).toBe(2n + 130n * secondNs);
    expect(
      failed.slots.reduce(
        (sum: bigint, slot: { readonly budgetNs: bigint }) => sum + slot.budgetNs,
        0n,
      ),
    ).toBe(
      105n * secondNs,
    );
    expect(expectedCutSupervisorOperation(failed)).toBe("accepted-id-validation");
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "skip-slot", operation: "accepted-id-validation" },
      clock(failed.lastBootNs),
    );
    const noIdOperations = [
      "exact-name-recovery",
      "final-exact-name-census",
      "final-label-census",
    ] as const;
    for (const operation of noIdOperations) {
      while (expectedCutSupervisorOperation(failed) !== operation) {
        failed = reduceCutSupervisorCursor(
          failed,
          { type: "skip-slot", operation: expectedCutSupervisorOperation(failed)! },
          clock(failed.lastBootNs),
        );
      }
      failed = reduceCutSupervisorCursor(
        failed,
        { type: "begin-slot", operation, token: createOwnedChildToken() },
        clock(failed.lastBootNs),
      );
      const childToken = failed.active!.token;
      const receipt = operation === "final-label-census"
        ? parseDockerLabelCensus(
            dockerResult(0, ""),
            invocation,
            dockerReceiptSource(operation, childToken),
          )
        : exactProofNameAbsent(childToken, operation);
      failed = reduceCutSupervisorCursor(
        failed,
        {
          type: "complete-slot",
          operation,
          outcome: "pass",
          reaped: true,
          token: failed.active!.token,
          receipt,
        },
        clock(failed.lastBootNs),
      );
    }
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "failed-path-helper", token: createOwnedChildToken() },
      clock(failed.lastBootNs),
    );
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "complete-slot",
        operation: "failed-path-helper",
        outcome: "pass",
        reaped: true,
        token: failed.active!.token,
      },
      clock(failed.lastBootNs),
    );
    for (const operation of ["parent-absence", "descriptor-settlement"]) {
      failed = reduceCutSupervisorCursor(
        failed,
        { type: "begin-slot", operation },
        clock(failed.lastBootNs),
      );
      failed = reduceCutSupervisorCursor(
        failed,
        { type: "complete-slot", operation, outcome: "pass" },
        clock(failed.lastBootNs),
      );
    }
    expect(failed).toMatchObject({ phase: "failed-complete", failed: true });
    expect(failed.teardownDeadlineNs! - failed.lastBootNs).toBeGreaterThanOrEqual(
      25n * secondNs,
    );

    const earlyHarnessToken = createOwnedChildToken();
    let early = createCutSupervisorCursor({
      cutCase: "after-parent-custody-before-start",
      harnessToken: earlyHarnessToken,
      invocation,
      sample: clock(0n),
    });
    early = reduceCutSupervisorCursor(
      early,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt(
          "after-parent-custody-before-start",
          id,
          earlyHarnessToken,
        ),
      },
      clock(1n),
    );
    expect(() =>
      reduceCutSupervisorCursor(
        early,
        {
          type: "begin-slot",
          operation: "accepted-id-absence",
          token: createOwnedChildToken(),
          id,
        },
        clock(1n + 50n * secondNs),
      ),
    ).toThrow("post-reap deadline");

    const beforeHarnessToken = createOwnedChildToken();
    let before = createCutSupervisorCursor({
      cutCase: "before-issue",
      harnessToken: beforeHarnessToken,
      invocation,
      sample: clock(0n),
    });
    before = reduceCutSupervisorCursor(
      before,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt("before-issue", null, beforeHarnessToken),
      },
      clock(1n),
    );
    expect(before).toMatchObject({
      postReapBudgetNs: 40n * secondNs,
      postReapDeadlineNs: 1n + 40n * secondNs,
    });
    expect(() =>
      reduceCutSupervisorCursor(
        before,
        {
          type: "begin-slot",
          operation: "exact-name-census",
          token: createOwnedChildToken(),
        },
        clock(1n + 14n * secondNs),
      ),
    ).toThrow("suffix exhausted");
  });

  it("enforces five/two/three Docker and four/three/three helper child slots", () => {
    const id = "e".repeat(64);
    const cutHarnessToken = createOwnedChildToken();
    let cut = createCutSupervisorCursor({
      cutCase: "after-parent-custody-before-start",
      harnessToken: cutHarnessToken,
      invocation,
      sample: clock(0n),
    });
    cut = reduceCutSupervisorCursor(
      cut,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt("after-parent-custody-before-start", id, cutHarnessToken),
      },
      clock(1n),
    );
    const token = createOwnedChildToken();
    cut = reduceCutSupervisorCursor(
      cut,
      { type: "begin-slot", operation: "accepted-id-absence", token, id },
      clock(1n),
    );
    expect(cut.active).toMatchObject({
      normalEndNs: 1n + 5n * secondNs,
      termEndNs: 1n + 7n * secondNs,
      endNs: 1n + 10n * secondNs,
    });
    expect(() =>
      reduceCutSupervisorCursor(
        cut,
        {
          type: "complete-slot",
          operation: "accepted-id-absence",
          outcome: "pass",
          reaped: true,
          token,
          id,
          receipt: parseDockerAbsence(
            dockerResult(1, "[]\n", `Error response from daemon: No such container: ${id}\n`),
            id,
            dockerReceiptSource("accepted-id-absence", token),
          ),
        },
        clock(1n + 5n * secondNs),
      ),
    ).toThrow("child stage missing");
    cut = reduceCutSupervisorCursor(
      cut,
      { type: "advance-slot-stage", operation: "accepted-id-absence", stage: "term", token },
      clock(1n + 5n * secondNs),
    );
    cut = reduceCutSupervisorCursor(
      cut,
      { type: "advance-slot-stage", operation: "accepted-id-absence", stage: "kill", token },
      clock(1n + 7n * secondNs),
    );
    cut = reduceCutSupervisorCursor(
      cut,
      {
        type: "complete-slot",
        operation: "accepted-id-absence",
        outcome: "pass",
        reaped: true,
        token,
        id,
        receipt: parseDockerAbsence(
          dockerResult(1, "[]\n", `Error response from daemon: No such container: ${id}\n`),
          id,
          dockerReceiptSource("accepted-id-absence", token),
        ),
      },
      clock(1n + 10n * secondNs - 1n),
    );
    expect(cut.slotIndex).toBe(1);

    const failedHarnessToken = createOwnedChildToken();
    let failed = createCutSupervisorCursor({
      cutCase: "before-issue",
      harnessToken: failedHarnessToken,
      invocation,
      sample: clock(0n),
    });
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt("before-issue", null, failedHarnessToken, false),
      },
      clock(1n),
    );
    failed = reduceCutSupervisorCursor(failed, { type: "begin-failed-teardown" }, clock(2n));
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "skip-slot", operation: "accepted-id-validation" },
      clock(failed.lastBootNs),
    );
    for (const operation of [
      "exact-name-recovery",
      "final-exact-name-census",
      "final-label-census",
    ] as const) {
      while (expectedCutSupervisorOperation(failed) !== operation) {
        failed = reduceCutSupervisorCursor(
          failed,
          { type: "skip-slot", operation: expectedCutSupervisorOperation(failed)! },
          clock(failed.lastBootNs),
        );
      }
      failed = reduceCutSupervisorCursor(
        failed,
        { type: "begin-slot", operation, token: createOwnedChildToken() },
        clock(failed.lastBootNs),
      );
      const childToken = failed.active!.token;
      const receipt = operation === "final-label-census"
        ? parseDockerLabelCensus(
            dockerResult(0, ""),
            invocation,
            dockerReceiptSource(operation, childToken),
          )
        : exactProofNameAbsent(childToken, operation);
      failed = reduceCutSupervisorCursor(
        failed,
        {
          type: "complete-slot",
          operation,
          outcome: "pass",
          reaped: true,
          token: failed.active!.token,
          receipt,
        },
        clock(failed.lastBootNs),
      );
    }
    const helperToken = createOwnedChildToken();
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "failed-path-helper", token: helperToken },
      clock(failed.lastBootNs),
    );
    expect(failed.active).toMatchObject({
      normalEndNs: failed.lastBootNs + 4n * secondNs,
      termEndNs: failed.lastBootNs + 7n * secondNs,
      endNs: failed.lastBootNs + 10n * secondNs,
    });
    expect(() =>
      reduceCutSupervisorCursor(
        failed,
        {
          type: "complete-slot",
          operation: "failed-path-helper",
          outcome: "pass",
          reaped: false,
          token: helperToken,
        },
        clock(failed.lastBootNs),
      ),
    ).toThrow("unreaped cut supervisor child cannot pass");
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "advance-slot-stage",
        operation: "failed-path-helper",
        stage: "term",
        token: helperToken,
      },
      clock(failed.lastBootNs + 4n * secondNs),
    );
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "advance-slot-stage",
        operation: "failed-path-helper",
        stage: "kill",
        token: helperToken,
      },
      clock(failed.lastBootNs + 3n * secondNs),
    );
    expect(() =>
      reduceCutSupervisorCursor(
        failed,
        { type: "expire-slot", operation: "failed-path-helper", token: helperToken },
        clock(failed.lastBootNs + 3n * secondNs - 1n),
      ),
    ).toThrow("has not expired after KILL");
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "expire-slot", operation: "failed-path-helper", token: helperToken },
      clock(failed.lastBootNs + 3n * secondNs),
    );
    expect(expectedCutSupervisorOperation(failed)).toBe("parent-absence");
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "parent-absence" },
      clock(failed.lastBootNs),
    );
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "complete-slot", operation: "parent-absence", outcome: "fail" },
      clock(failed.lastBootNs),
    );
    expect(expectedCutSupervisorOperation(failed)).toBe("descriptor-settlement");
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "descriptor-settlement" },
      clock(failed.lastBootNs),
    );
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "complete-slot", operation: "descriptor-settlement", outcome: "pass" },
      clock(failed.lastBootNs),
    );
    expect(failed).toMatchObject({ phase: "failed-complete", failed: true });
  });

  it("adopts only an identity-valid full ID and binds every removal and absence to it", () => {
    const id = "f".repeat(64);
    const otherId = "a".repeat(64);
    const failedHarnessToken = createOwnedChildToken();
    let failed = createCutSupervisorCursor({
      cutCase: "after-daemon-accept-before-delivery",
      harnessToken: failedHarnessToken,
      invocation,
      sample: clock(0n),
    });
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt(
          "after-daemon-accept-before-delivery",
          id,
          failedHarnessToken,
          false,
        ),
      },
      clock(1n),
    );
    failed = reduceCutSupervisorCursor(failed, { type: "begin-failed-teardown" }, clock(2n));

    const validationToken = createOwnedChildToken();
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "accepted-id-validation", token: validationToken },
      clock(2n),
    );
    expect(() =>
      reduceCutSupervisorCursor(
        failed,
        {
          type: "complete-slot",
          operation: "accepted-id-validation",
          outcome: "pass",
          reaped: true,
          token: validationToken,
          receipt: inspectedProof(otherId, validationToken, "accepted-id-validation"),
        },
        clock(2n),
      ),
    ).toThrow("accepted-ID validation receipt");
    const validationCursor = failed;
    const validationReceipt = inspectedProof(id, validationToken, "accepted-id-validation");
    failed = reduceCutSupervisorCursor(
      validationCursor,
      {
        type: "complete-slot",
        operation: "accepted-id-validation",
        outcome: "pass",
        reaped: true,
        token: validationToken,
        receipt: validationReceipt,
      },
      clock(2n),
    );
    expect(() =>
      reduceCutSupervisorCursor(
        validationCursor,
        {
          type: "complete-slot",
          operation: "accepted-id-validation",
          outcome: "pass",
          reaped: true,
          token: validationToken,
          receipt: validationReceipt,
        },
        clock(2n),
      ),
    ).toThrow("provenance mismatch or replay");
    expect(failed.adoptedId).toBe(id);
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "skip-slot", operation: "exact-name-recovery" },
      clock(2n),
    );

    expect(() =>
      reduceCutSupervisorCursor(
        failed,
        { type: "begin-slot", operation: "remove-1", token: createOwnedChildToken(), id: otherId },
        clock(2n),
      ),
    ).toThrow("cleanup identity mismatch");
    const removeToken = createOwnedChildToken();
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "remove-1", token: removeToken, id },
      clock(2n),
    );
    expect(() =>
      reduceCutSupervisorCursor(
        failed,
        {
          type: "complete-slot",
          operation: "remove-1",
          outcome: "pass",
          reaped: true,
          token: removeToken,
          id,
          receipt: parseDockerRemove(
            dockerResult(0, `${otherId}\n`),
            otherId,
            dockerReceiptSource("remove-1", removeToken),
          ),
        },
        clock(2n),
      ),
    ).toThrow("removal receipt");
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "complete-slot",
        operation: "remove-1",
        outcome: "pass",
        reaped: true,
        token: removeToken,
        id,
        receipt: parseDockerRemove(
          dockerResult(0, `${id}\n`),
          id,
          dockerReceiptSource("remove-1", removeToken),
        ),
      },
      clock(2n),
    );

    const absenceToken = createOwnedChildToken();
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "begin-slot", operation: "absence-1", token: absenceToken, id },
      clock(2n),
    );
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "complete-slot",
        operation: "absence-1",
        outcome: "pass",
        reaped: true,
        token: absenceToken,
        id,
        receipt: parseDockerAbsence(
          dockerResult(1, "[]\n", `Error response from daemon: No such container: ${id}\n`),
          id,
          dockerReceiptSource("absence-1", absenceToken),
        ),
      },
      clock(2n),
    );
    expect(failed.absenceProved).toBe(true);
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "skip-slot", operation: "remove-2" },
      clock(2n),
    );
    failed = reduceCutSupervisorCursor(
      failed,
      { type: "skip-slot", operation: "absence-2" },
      clock(2n),
    );
    expect(expectedCutSupervisorOperation(failed)).toBe("final-exact-name-census");
    const finalNameToken = createOwnedChildToken();
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "begin-slot",
        operation: "final-exact-name-census",
        token: finalNameToken,
      },
      clock(2n),
    );
    expect(() =>
      reduceCutSupervisorCursor(
        failed,
        {
          type: "complete-slot",
          operation: "final-exact-name-census",
          outcome: "pass",
          reaped: true,
          token: finalNameToken,
          receipt: exactProofNameAbsent(finalNameToken, "exact-name-recovery"),
        },
        clock(2n),
      ),
    ).toThrow("provenance mismatch or replay");
    failed = reduceCutSupervisorCursor(
      failed,
      {
        type: "complete-slot",
        operation: "final-exact-name-census",
        outcome: "pass",
        reaped: true,
        token: finalNameToken,
        receipt: exactProofNameAbsent(finalNameToken, "final-exact-name-census"),
      },
      clock(2n),
    );
    expect(expectedCutSupervisorOperation(failed)).toBe("final-label-census");

    const recoveredHarnessToken = createOwnedChildToken();
    let recovered = createCutSupervisorCursor({
      cutCase: "before-issue",
      harnessToken: recoveredHarnessToken,
      invocation,
      sample: clock(0n),
    });
    recovered = reduceCutSupervisorCursor(
      recovered,
      {
        type: "harness-reaped",
        receipt: cutReapReceipt("before-issue", null, recoveredHarnessToken, false),
      },
      clock(1n),
    );
    recovered = reduceCutSupervisorCursor(
      recovered,
      { type: "begin-failed-teardown" },
      clock(2n),
    );
    recovered = reduceCutSupervisorCursor(
      recovered,
      { type: "skip-slot", operation: "accepted-id-validation" },
      clock(2n),
    );
    const recoveryToken = createOwnedChildToken();
    recovered = reduceCutSupervisorCursor(
      recovered,
      { type: "begin-slot", operation: "exact-name-recovery", token: recoveryToken },
      clock(2n),
    );
    recovered = reduceCutSupervisorCursor(
      recovered,
      {
        type: "complete-slot",
        operation: "exact-name-recovery",
        outcome: "pass",
        reaped: true,
        token: recoveryToken,
        receipt: inspectedProof(id, recoveryToken, "exact-name-recovery"),
      },
      clock(2n),
    );
    expect(recovered).toMatchObject({ adoptedId: id, absenceProved: false });
    expect(expectedCutSupervisorOperation(recovered)).toBe("remove-1");
  });
});
