import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SOURCE_ROOTS,
  advanceFreshRootCopyBudget,
  assertCompileTimeInputs,
  assertNoFixedWorkspaceMountpoints,
  buildSourceLedgerRows,
  createFreshRootCopyBudget,
  parseSourceIndex,
  stageFixedSourceSnapshot,
  verifySourceLedgerRows,
} from "../scripts/cargo.mjs";
import type {
  abandonFreshRootHandoff,
  claimFreshRootHandoffFailure,
  launchAfterDaemonAcceptBeforeDeliveryFreshRoot,
  launchAfterParentCustodyBeforeStartFreshRoot,
  launchBeforeIssueFreshRoot,
  prepareFreshLedgerBackedRoot,
} from "../scripts/cargo.mjs";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
const coordinatorCargoName = "openspell-hosted-migration-preparation-proof";
const coordinatorNpmName = "@wizard-ads/hosted-migration-preparation-proof";
const coordinatorPathStem = "hosted-migration-preparation-proof";
const rootAuthorityCargoName = "openspell-hosted-migration-root-authority";
const runtimeProofCargoName = "openspell-hosted-migration-runtime-proof";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sourceIndexBytes(): Buffer {
  return execFileSync(
    "/usr/bin/git",
    ["ls-files", "--stage", "-z", "--", ...SOURCE_ROOTS],
    { cwd: workspaceDirectory, maxBuffer: 1024 * 1024 },
  );
}

function openBootClockDescriptors(): number {
  let total = 0;
  for (const name of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${name}`) === "/proc/uptime") total += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}

function makeTreeWritable(path: string): void {
  const status = lstatSync(path);
  if (!status.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isDirectory()) makeTreeWritable(child);
  }
}

function removeFixture(path: string): void {
  try {
    makeTreeWritable(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  rmSync(path, { force: true, recursive: true });
}

function createInvocationDestination(): {
  readonly invocation: string;
  readonly source: string;
} {
  const invocation = join(
    "/tmp",
    `openspell-wp201-root-proof-${randomBytes(32).toString("hex")}`,
  );
  mkdirSync(invocation, { mode: 0o700 });
  const invocationValue = invocation.slice(invocation.lastIndexOf("-") + 1);
  const record = openSync(
    join(invocation, "INVOCATION"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(record, `openspell.wp201.invocation.v1\n${invocationValue}\n`);
    fsyncSync(record);
  } finally {
    closeSync(record);
  }
  const source = join(invocation, "source");
  mkdirSync(source, { mode: 0o700 });
  const invocationDirectory = openSync(
    invocation,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(invocationDirectory);
  } finally {
    closeSync(invocationDirectory);
  }
  return { invocation, source };
}

type CargoModule = {
  readonly abandonFreshRootHandoff: typeof abandonFreshRootHandoff;
  readonly claimFreshRootHandoffFailure: typeof claimFreshRootHandoffFailure;
  readonly assertNoFixedWorkspaceMountpoints: typeof assertNoFixedWorkspaceMountpoints;
  readonly launchAfterDaemonAcceptBeforeDeliveryFreshRoot: typeof launchAfterDaemonAcceptBeforeDeliveryFreshRoot;
  readonly launchAfterParentCustodyBeforeStartFreshRoot: typeof launchAfterParentCustodyBeforeStartFreshRoot;
  readonly launchBeforeIssueFreshRoot: typeof launchBeforeIssueFreshRoot;
  readonly prepareFreshLedgerBackedRoot: typeof prepareFreshLedgerBackedRoot;
  readonly stageFixedSourceSnapshot: typeof stageFixedSourceSnapshot;
  readonly fixtureSpawnError?: Error;
  readonly fixtureReleaseError?: Error;
  readonly fixtureAbortError?: Error;
  readonly fixtureDescriptorCloseError?: Error;
  readonly fixtureDescriptorProbeError?: Error;
  readonly fixtureClassifyCleanupChildPoll?: (
    closed: boolean,
    sampleNanoseconds: bigint,
    slotDeadlineNanoseconds: bigint,
  ) => "closed" | "expired" | "waiting";
  readonly fixtureSettlePrivateDescriptor?: (
    descriptor: number,
    expected: Readonly<Record<string, bigint | string>>,
  ) => { readonly identityMismatch?: boolean; readonly settled: boolean };
  readonly fixtureSettlePrivateDescriptorIdentity?: (
    expected: Readonly<Record<string, bigint | string>>,
    protectedDescriptors?: readonly number[],
  ) => {
    readonly observedMatches: number;
    readonly protectedMatches: number;
    readonly remainingMatches: number;
    readonly settled: boolean;
  };
};

async function copiedCargoModule(
  index: Buffer,
  transform: (source: string) => string = (source) => source,
): Promise<{
  readonly directory: string;
  readonly module: CargoModule;
}> {
  const directory = mkdtempSync(join(tmpdir(), "wp201-source-workspace-"));
  const records = parseSourceIndex(index);
  for (const { path } of records) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { mode: 0o700, recursive: true });
    copyFileSync(join(workspaceDirectory, path), destination);
    chmodSync(destination, 0o600);
  }
  const modulePath = join(
    directory,
    "tools/hosted-migration-preparation-proof/scripts/cargo.mjs",
  );
  mkdirSync(dirname(modulePath), { mode: 0o700, recursive: true });
  copyFileSync(
    join(packageDirectory, "scripts/path-cleanup-helper.mjs"),
    join(dirname(modulePath), "path-cleanup-helper.mjs"),
  );
  copyFileSync(
    join(packageDirectory, "scripts/child-containment.mjs"),
    join(dirname(modulePath), "child-containment.mjs"),
  );
  copyFileSync(
    join(packageDirectory, "scripts/child-containment-launcher.mjs"),
    join(dirname(modulePath), "child-containment-launcher.mjs"),
  );
  writeFileSync(
    modulePath,
    transform(readFileSync(join(packageDirectory, "scripts/cargo.mjs"), "utf8")),
  );
  const module = await import(
    `${pathToFileURL(modulePath).href}?fixture=${randomBytes(8).toString("hex")}`
  ) as CargoModule;
  return { directory, module };
}

async function settleCopiedContainedChild(
  directory: string,
  child: NonNullable<ReturnType<typeof launchBeforeIssueFreshRoot>["child"]>,
): Promise<void> {
  const containment = await import(
    pathToFileURL(join(
      directory,
      "tools/hosted-migration-preparation-proof/scripts/child-containment.mjs",
    )).href
  ) as {
    readonly abortContainedChild: (value: typeof child) => void;
    readonly settleContainedChild: (value: typeof child) => {
      readonly empty: boolean;
      readonly errors: readonly Error[];
      readonly settled: boolean;
    };
  };
  containment.abortContainedChild(child);
  if (child.exitCode === null && child.signalCode === null) await once(child, "close");
  const status = child.stdio[9];
  if (status !== null && "readableEnded" in status && !status.readableEnded) {
    await once(status, "end");
  }
  expect(containment.settleContainedChild(child)).toMatchObject({ empty: true, settled: true });
  for (const stream of child.stdio) stream?.destroy();
}

type CompactCompleteFixture = {
  readonly acquisitionController: Buffer;
  readonly counts: {
    readonly controlFiles: number;
    readonly sourceDirectories: number;
    readonly sourceFiles: number;
    readonly toolchainBytes: bigint;
    readonly toolchainDirectories: number;
    readonly toolchainFiles: number;
    readonly vendorBytes: bigint;
    readonly vendorDirectories: number;
    readonly vendorFiles: number;
  };
  readonly ledger: Buffer;
  readonly proofController: Buffer;
  readonly registryPackages: ReadonlyMap<string, string>;
  readonly toolchainAuthority: {
    readonly bodyDigest: string;
    readonly digest: string;
    readonly length: number;
    readonly records: number;
  };
  readonly toolchainBytes: Buffer;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compactCompleteFixture(): CompactCompleteFixture {
  const index = sourceIndexBytes();
  const records = parseSourceIndex(index);
  const sourceBytes = new Map(
    records.map(({ path }) => [path, readFileSync(join(workspaceDirectory, path))]),
  );
  const rows = buildSourceLedgerRows(records, sourceBytes).ledgerRows
    .split("\n")
    .filter((row) => row.length > 0);
  const registryPackages = new Map<string, string>();
  for (const packageName of [
    "hosted-migration-preparation-proof",
    "hosted-migration-root-authority",
    "hosted-migration-runtime-proof",
  ]) {
    const lock = read(join(workspaceDirectory, "tools", packageName, "Cargo.lock"));
    for (const block of lock.split("[[package]]").slice(1)) {
      const field = (name: string): string | undefined =>
        new RegExp(`^${name} = "([^"]+)"$`, "mu").exec(block)?.[1];
      const source = field("source");
      if (source === undefined) continue;
      expect(source).toBe("registry+https://github.com/rust-lang/crates.io-index");
      const name = field("name");
      const version = field("version");
      const checksum = field("checksum");
      if (name === undefined || version === undefined || checksum === undefined) {
        throw new Error("compact fixture Cargo lock is incomplete");
      }
      const directory = `${name}-${version}`;
      expect(registryPackages.get(directory) ?? checksum).toBe(checksum);
      registryPackages.set(directory, checksum);
    }
  }
  expect(registryPackages.size).toBe(70);

  rows.push("D\t0555\tvendor");
  let vendorBytes = 0n;
  for (const [directory, checksum] of [...registryPackages].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    const bytes = Buffer.from(JSON.stringify({ files: {}, package: checksum }));
    vendorBytes += BigInt(bytes.length);
    rows.push(`D\t0555\tvendor/${directory}`);
    rows.push(
      ["V", "0444", bytes.length, sha256(bytes), `${directory}/.cargo-checksum.json`].join(
        "\t",
      ),
    );
  }

  const toolchainBytes = Buffer.alloc(1024 * 1024 + 17, 0xa5);
  rows.push("D\t0555\ttoolchain");
  rows.push("D\t0555\ttoolchain/bin");
  rows.push(
    ["T", "0555", toolchainBytes.length, sha256(toolchainBytes), "bin/rustc"].join("\t"),
  );

  const proofController = Buffer.from("#!/bin/sh\nexit 0\n");
  const controls = new Map([
    ["control/proof.sh", proofController],
    ["etc/hostname", Buffer.from("wp201-proof\n")],
    ["etc/hosts", Buffer.from("127.0.0.1 localhost\n::1 localhost\n")],
    ["etc/resolv.conf", Buffer.alloc(0)],
  ]);
  for (const [path, bytes] of controls) {
    rows.push(`C\t0444\t${bytes.length}\t${sha256(bytes)}\t${path}`);
  }
  rows.sort((left, right) => {
    const leftFields = left.split("\t");
    const rightFields = right.split("\t");
    return Buffer.compare(
      Buffer.from(`${leftFields[0]}\t${leftFields.at(-1)}`),
      Buffer.from(`${rightFields[0]}\t${rightFields.at(-1)}`),
    );
  });
  const body = Buffer.from(
    `openspell.wp201.vendor-ledger.v1\nrecords\t${rows.length}\n${rows.join("\n")}\n`,
  );
  const ledger = Buffer.concat([body, Buffer.from(`end\t${sha256(body)}\n`)]);
  const authorityRows = rows.filter((row) =>
    row.startsWith("T\t") || row === "D\t0555\ttoolchain" || row.startsWith("D\t0555\ttoolchain/"),
  );
  const authorityBody = Buffer.from(
    `openspell.wp201.toolchain-authority.v1\nrecords\t${authorityRows.length}\n${authorityRows.join("\n")}\n`,
  );
  const authority = Buffer.concat([
    authorityBody,
    Buffer.from(`end\t${sha256(authorityBody)}\n`),
  ]);
  return {
    acquisitionController: Buffer.from("#!/bin/sh\nexit 0\n"),
    counts: {
      controlFiles: 4,
      sourceDirectories: 10,
      sourceFiles: 45,
      toolchainBytes: BigInt(toolchainBytes.length),
      toolchainDirectories: 2,
      toolchainFiles: 1,
      vendorBytes,
      vendorDirectories: registryPackages.size + 1,
      vendorFiles: registryPackages.size,
    },
    ledger,
    proofController,
    registryPackages,
    toolchainAuthority: {
      bodyDigest: sha256(authorityBody),
      digest: sha256(authority),
      length: authority.length,
      records: authorityRows.length,
    },
    toolchainBytes,
  };
}

function replaceExactly(source: string, expected: string, replacement: string): string {
  const first = source.indexOf(expected);
  if (first === -1 || source.indexOf(expected, first + expected.length) !== -1) {
    throw new Error(`fixture transform expected one source occurrence: ${expected.slice(0, 48)}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

function compactFixtureTransform(
  fixture: CompactCompleteFixture,
  injections: {
    readonly afterDirectoryCreate?: string;
    readonly afterInvocationSync?: string;
    readonly abortFailure?: boolean;
    readonly beforeSettledSourceVerification?: string;
    readonly exposeCleanupPollClassifier?: boolean;
    readonly exposeDescriptorSettlement?: boolean;
    readonly firstDescriptorCloseFailure?: boolean;
    readonly firstDescriptorProbeFailure?: boolean;
    readonly initialFailure?: "random" | "sample";
    readonly releaseFailure?: boolean;
    readonly spawnFailure?: boolean;
  } = {},
): (source: string) => string {
  return (input) => {
    let source = input;
    source = replaceExactly(
      source,
      "const completeLedgerRecords = 4_853;",
      `const completeLedgerRecords = ${fixture.counts.sourceDirectories + fixture.counts.sourceFiles + fixture.counts.vendorDirectories + fixture.counts.vendorFiles + fixture.counts.toolchainDirectories + fixture.counts.toolchainFiles + fixture.counts.controlFiles};`,
    );
    source = replaceExactly(
      source,
      `const expectedTreeCounts = Object.freeze({\n  sourceDirectories: 10,\n  sourceFiles: 45,\n  vendorDirectories: 941,\n  vendorFiles: 3_657,\n  vendorBytes: 67_159_121n,\n  toolchainDirectories: 28,\n  toolchainFiles: 168,\n  toolchainBytes: 653_573_520n,\n  controlFiles: 4,\n});`,
      `const expectedTreeCounts = Object.freeze(${JSON.stringify({
        ...fixture.counts,
        toolchainBytes: undefined,
        vendorBytes: undefined,
      }).replace(/\}$/u, `,"vendorBytes":${fixture.counts.vendorBytes}n,"toolchainBytes":${fixture.counts.toolchainBytes}n}`)});`,
    );
    source = replaceExactly(
      source,
      `const expectedToolchainAuthoritySha256 =\n  "6078f49e711c3a7059e11a8a7b37f5f49837c792523bd914e0592b42d8f087a4";`,
      `const expectedToolchainAuthoritySha256 = "${fixture.toolchainAuthority.digest}";`,
    );
    source = replaceExactly(
      source,
      `const acquisitionController = Object.freeze({\n  size: 9_956,\n  digest: "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258",\n});`,
      `const acquisitionController = Object.freeze({ size: ${fixture.acquisitionController.length}, digest: "${sha256(fixture.acquisitionController)}" });`,
    );
    source = replaceExactly(
      source,
      `const proofController = Object.freeze({\n  size: 30_322,\n  digest: "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb",\n});`,
      `const proofController = Object.freeze({ size: ${fixture.proofController.length}, digest: "${sha256(fixture.proofController)}" });`,
    );
    source = replaceExactly(source, "authorityRows.length !== 196", `authorityRows.length !== ${fixture.toolchainAuthority.records}`);
    source = replaceExactly(source, "authority.length !== 30_553", `authority.length !== ${fixture.toolchainAuthority.length}`);
    source = replaceExactly(
      source,
      `authorityEnd !== "1dcabbf3617ff9821771b09f430a636af81077b643bf32385aadd3c0b9fc1274"`,
      `authorityEnd !== "${fixture.toolchainAuthority.bodyDigest}"`,
    );
    if ((injections.afterDirectoryCreate?.length ?? 0) > 0) {
      const obligation = `destination = Object.freeze({ cleanupKind: "identity-uncertain", destinationPath: path, parent });\n      advanceHeldFreshRootBudget(budgetState, "work", clock);\n      const reached = lstatSync(path, { bigint: true });`;
      source = replaceExactly(
        source,
        obligation,
        `destination = Object.freeze({ cleanupKind: "identity-uncertain", destinationPath: path, parent });\n      ${injections.afterDirectoryCreate}\n      advanceHeldFreshRootBudget(budgetState, "work", clock);\n      const reached = lstatSync(path, { bigint: true });`,
      );
    }
    if ((injections.afterInvocationSync?.length ?? 0) > 0) {
      const transition = `advanceHeldFreshRootBudget(budgetState, "record-synced", clock);`;
      source = replaceExactly(source, transition, `${transition}\n    ${injections.afterInvocationSync}`);
    }
    if ((injections.beforeSettledSourceVerification?.length ?? 0) > 0) {
      const verification = `const settledSourceProof = await verifyCompleteInvocation(source, budgetState, clock);`;
      source = replaceExactly(source, verification, `${injections.beforeSettledSourceVerification}\n    ${verification}`);
    }
    if (injections.firstDescriptorCloseFailure === true) {
      const settlement = `function settlePrivateDescriptor(descriptor, expected) {\n  let observedBefore;`;
      source = replaceExactly(
        source,
        settlement,
        `let fixtureDescriptorCloseFailure = true;\n` +
          `let fixtureDescriptorProbeFailure = ${injections.firstDescriptorProbeFailure === true};\n` +
          `const fixtureDescriptorCloseError = new Error("fixture descriptor close failure");\n` +
          `const fixtureDescriptorProbeError = new Error("fixture descriptor probe failure");\n\n${settlement}`,
      );
      const close = `try {\n    closeSync(descriptor);\n  } catch (error) {\n    closeError = error;\n  }`;
      source = replaceExactly(
        source,
        close,
        `try {\n    if (fixtureDescriptorCloseFailure) {\n      fixtureDescriptorCloseFailure = false;\n      throw fixtureDescriptorCloseError;\n    }\n    closeSync(descriptor);\n  } catch (error) {\n    closeError = error;\n  }`,
      );
      if (injections.firstDescriptorProbeFailure === true) {
        const probe = `let observed;\n  probeError = undefined;\n  try {\n    observed = observePrivateDescriptor(descriptor);`;
        source = replaceExactly(
          source,
          probe,
          `let observed;\n  probeError = undefined;\n  try {\n    if (fixtureDescriptorProbeFailure) {\n      fixtureDescriptorProbeFailure = false;\n      throw fixtureDescriptorProbeError;\n    }\n    observed = observePrivateDescriptor(descriptor);`,
        );
      }
      source += "\nexport { fixtureDescriptorCloseError, fixtureDescriptorProbeError };\n";
    }
    if (injections.spawnFailure === true) {
      source = replaceExactly(
        source,
        "function launchFixedFreshRootCut(token, program) {",
        'const fixtureSpawnError = new Error("fixture synchronous spawn failure");\n\n' +
          "function launchFixedFreshRootCut(token, program) {",
      );
      source = replaceExactly(
        source,
        "    child = spawnContained(\n      spawn,\n      capturedNodeExecutable,",
        "    throw fixtureSpawnError;\n    child = spawnContained(\n      spawn,\n      capturedNodeExecutable,",
      );
      source += "\nexport { fixtureSpawnError };\n";
    }
    if (injections.releaseFailure === true) {
      source = replaceExactly(
        source,
        "function launchFixedFreshRootCut(token, program) {",
        'const fixtureReleaseError = new Error("fixture contained child release failure");\n\n' +
          "function launchFixedFreshRootCut(token, program) {",
      );
      source = replaceExactly(
        source,
        "      releaseContainedChild(child);",
        "      throw fixtureReleaseError;",
      );
      source += "\nexport { fixtureReleaseError };\n";
    }
    if (injections.abortFailure === true) {
      source = replaceExactly(
        source,
        "function launchFixedFreshRootCut(token, program) {",
        'const fixtureAbortError = new Error("fixture contained child abort failure");\n\n' +
          "function launchFixedFreshRootCut(token, program) {",
      );
      source = replaceExactly(
        source,
        "        abortContainedChild(child);",
        "        throw fixtureAbortError;",
      );
      source += "\nexport { fixtureAbortError };\n";
    }
    if (injections.initialFailure === "sample") {
      source = replaceExactly(
        source,
        `budgetState = { signal, value: createFreshRootCopyBudget(clock.sample()) };`,
        `budgetState = { signal, value: createFreshRootCopyBudget((() => { throw new Error("fixture initial sample failure"); })()) };`,
      );
    }
    if (injections.initialFailure === "random") {
      source = replaceExactly(
        source,
        `invocation = randomBytes(32).toString("hex");`,
        `throw new Error("fixture invocation entropy failure");`,
      );
    }
    if (injections.exposeCleanupPollClassifier === true) {
      const classifier = "function classifyCleanupChildPoll(closed, sampleNanoseconds, slotDeadlineNanoseconds) {";
      source = replaceExactly(
        source,
        classifier,
        `export ${classifier.replace("classifyCleanupChildPoll", "fixtureClassifyCleanupChildPoll")}`,
      );
      source = source.replaceAll(
        "classifyCleanupChildPoll(",
        "fixtureClassifyCleanupChildPoll(",
      );
    }
    if (injections.exposeDescriptorSettlement === true) {
      const identitySettlement =
        "function settlePrivateDescriptorIdentity(expected, protectedDescriptors = []) {";
      source = replaceExactly(
        source,
        identitySettlement,
        `export ${identitySettlement.replace("settlePrivateDescriptorIdentity", "fixtureSettlePrivateDescriptorIdentity")}`,
      );
      source = source.replaceAll(
        "settlePrivateDescriptorIdentity(",
        "fixtureSettlePrivateDescriptorIdentity(",
      );
      const settlement = "function settlePrivateDescriptor(descriptor, expected) {";
      source = replaceExactly(
        source,
        settlement,
        `export ${settlement.replace("settlePrivateDescriptor", "fixtureSettlePrivateDescriptor")}`,
      );
      source = source.replaceAll(
        "settlePrivateDescriptor(",
        "fixtureSettlePrivateDescriptor(",
      );
    }
    return source;
  };
}

async function createCompleteInvocationFixture(
  module: CargoModule,
  fixture: CompactCompleteFixture,
): Promise<{ readonly invocation: string; readonly sourceHandle: Awaited<ReturnType<typeof open>> }> {
  const destination = createInvocationDestination();
  const stagingHandle = await open(
    destination.source,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await module.stageFixedSourceSnapshot({
      indexBytes: sourceIndexBytes(),
      sourceDirectory: stagingHandle,
    });
  } finally {
    await stagingHandle.close();
  }
  const acquisition = join(destination.invocation, "acquisition");
  const vendor = join(acquisition, "vendor");
  const toolchain = join(acquisition, "toolchain");
  mkdirSync(vendor, { mode: 0o700, recursive: true });
  for (const [directory, checksum] of fixture.registryPackages) {
    const packageDirectory = join(vendor, directory);
    mkdirSync(packageDirectory, { mode: 0o700 });
    writeFileSync(
      join(packageDirectory, ".cargo-checksum.json"),
      JSON.stringify({ files: {}, package: checksum }),
      { mode: 0o444 },
    );
    chmodSync(packageDirectory, 0o555);
  }
  mkdirSync(join(toolchain, "bin"), { mode: 0o700, recursive: true });
  writeFileSync(join(toolchain, "bin/rustc"), fixture.toolchainBytes, { mode: 0o555 });
  chmodSync(join(toolchain, "bin"), 0o555);
  chmodSync(toolchain, 0o555);
  chmodSync(vendor, 0o555);
  writeFileSync(join(acquisition, "vendor-ledger.v1"), fixture.ledger, { mode: 0o444 });

  const control = join(destination.invocation, "control");
  mkdirSync(control, { mode: 0o700 });
  writeFileSync(join(control, "acquisition.sh"), fixture.acquisitionController, { mode: 0o444 });
  writeFileSync(join(control, "proof.sh"), fixture.proofController, { mode: 0o444 });
  writeFileSync(join(control, "hostname"), "wp201-proof\n", { mode: 0o444 });
  writeFileSync(join(control, "hosts"), "127.0.0.1 localhost\n::1 localhost\n", { mode: 0o444 });
  writeFileSync(join(control, "resolv.conf"), Buffer.alloc(0), { mode: 0o444 });
  chmodSync(control, 0o555);

  const docker = join(destination.invocation, "docker");
  mkdirSync(join(docker, "home"), { mode: 0o700, recursive: true });
  mkdirSync(join(docker, "config"), { mode: 0o700 });
  writeFileSync(join(docker, "config/config.json"), "{}", { mode: 0o400 });
  chmodSync(join(docker, "config"), 0o500);
  chmodSync(docker, 0o500);
  const sourceHandle = await open(
    destination.invocation,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  return { invocation: destination.invocation, sourceHandle };
}

function completeTreeSnapshot(root: string): ReadonlyMap<string, {
  readonly digest?: string;
  readonly inode: bigint;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size?: number;
}> {
  const result = new Map<string, {
    readonly digest?: string;
    readonly inode: bigint;
    readonly kind: "directory" | "file";
    readonly mode: number;
    readonly size?: number;
  }>();
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      const status = lstatSync(absolute, { bigint: true });
      if (entry.isDirectory() && status.isDirectory()) {
        result.set(path, { inode: status.ino, kind: "directory", mode: Number(status.mode & 0o7777n) });
        visit(absolute, path);
      } else if (entry.isFile() && status.isFile()) {
        const bytes = readFileSync(absolute);
        result.set(path, {
          digest: sha256(bytes),
          inode: status.ino,
          kind: "file",
          mode: Number(status.mode & 0o7777n),
          size: bytes.length,
        });
      } else {
        throw new Error(`unexpected compact fixture entry: ${path}`);
      }
    }
  };
  visit(root, "");
  return result;
}

function normalizedManifestText(contents: string): string {
  return contents
    .replace(/\\[\t ]*\r?\n[\t \r\n]*/gu, "")
    .replace(/\\x(?<hex>[0-9a-fA-F]{2})/gu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u(?<hex>[0-9a-fA-F]{4})/gu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\U(?<hex>[0-9a-fA-F]{8})/gu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function tomlTable(contents: string, name: string): string {
  const marker = `[${name}]`;
  const tableStart = contents.indexOf(marker);
  if (tableStart === -1) throw new Error(`missing exact ${marker} table`);
  const bodyStart = tableStart + marker.length;
  const nextTableOffset = contents.slice(bodyStart).search(/^\s*\[/mu);
  return contents.slice(
    bodyStart,
    nextTableOffset === -1 ? undefined : bodyStart + nextTableOffset,
  );
}

function workspaceManifests(): readonly string[] {
  const manifests: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`workspace manifest scan refuses symbolic link: ${join(directory, entry.name)}`);
      }
      if (entry.isDirectory()) {
        if ([".git", ".turbo", "node_modules", "target"].includes(entry.name)) continue;
        visit(join(directory, entry.name));
      } else if (entry.isFile() && ["Cargo.toml", "package.json"].includes(entry.name)) {
        manifests.push(join(directory, entry.name));
      }
    }
  };
  visit(workspaceDirectory);
  return manifests;
}

describe("WP-201 composition boundary", () => {
  it("selects exactly the tracked stage-zero Rust proof snapshot", () => {
    const index = sourceIndexBytes();
    const records = parseSourceIndex(index);
    expect(records).toHaveLength(45);
    const bytes = new Map(
      records.map(({ path }) => [path, readFileSync(join(workspaceDirectory, path))]),
    );
    expect(assertCompileTimeInputs(records, bytes)).toEqual([
      "tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json",
      "tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json",
      "tools/hosted-migration-root-authority/src/preparation_v2.rs",
      "tools/hosted-migration-root-authority/src/transition-v1.golden.json",
      "tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json",
      "tools/hosted-migration-runtime-proof/src/machine.rs",
    ]);

    const sourceLedger = buildSourceLedgerRows(records, bytes);
    expect(sourceLedger).toMatchObject({
      files: 45,
      directories: 10,
      regularFileBytes: 1_283_730,
      records: 55,
    });
    expect(Buffer.byteLength(sourceLedger.ledgerRows, "utf8")).toBe(6_533);
    expect(createHash("sha256").update(sourceLedger.ledgerRows).digest("hex")).toBe(
      "a8020e58a2ef55706e89498dd87cf4186f9e83e4c673f8273aaf96591b75a5a6",
    );
    expect(
      verifySourceLedgerRows(records, bytes, Buffer.from(sourceLedger.ledgerRows, "utf8")),
    ).toEqual(sourceLedger);
    const ledgerRows = sourceLedger.ledgerRows.split("\n").filter(Boolean);
    expect(ledgerRows).toHaveLength(55);
    expect(ledgerRows.slice(0, 10)).toEqual([
      "D\t0555\tsource",
      "D\t0555\tsource/tools",
      "D\t0555\tsource/tools/hosted-migration-preparation-proof",
      "D\t0555\tsource/tools/hosted-migration-preparation-proof/src",
      "D\t0555\tsource/tools/hosted-migration-root-authority",
      "D\t0555\tsource/tools/hosted-migration-root-authority/src",
      "D\t0555\tsource/tools/hosted-migration-root-authority/src/journal",
      "D\t0555\tsource/tools/hosted-migration-runtime-proof",
      "D\t0555\tsource/tools/hosted-migration-runtime-proof/fixtures",
      "D\t0555\tsource/tools/hosted-migration-runtime-proof/src",
    ]);
    expect(ledgerRows.slice(10).every((row) => row.startsWith("S\t0444\t"))).toBe(
      true,
    );

    const adversarial = new Map(bytes);
    const rootLibrary = records.find(
      ({ path }) => path === "tools/hosted-migration-root-authority/src/lib.rs",
    );
    expect(rootLibrary).toBeDefined();
    adversarial.set(
      rootLibrary?.path ?? "missing",
      Buffer.concat([
        bytes.get(rootLibrary?.path ?? "missing") ?? Buffer.alloc(0),
        Buffer.from('\nconst _: &str = include_str!(concat!("/etc/passwd"));\n'),
      ]),
    );
    expect(() => assertCompileTimeInputs(records, adversarial)).toThrow(
      "unsupported compile-time include form",
    );
  });

  it("refuses source index, object, byte, and ledger substitutions", () => {
    const index = sourceIndexBytes();
    const records = parseSourceIndex(index);
    const bytes = new Map(
      records.map(({ path }) => [path, readFileSync(join(workspaceDirectory, path))]),
    );
    const first = records[0];
    if (first === undefined) throw new Error("missing fixed source record");
    const firstRecord = `100644 ${first.object} 0\t${first.path}\0`;
    const indexText = index.toString("utf8");

    expect(() =>
      parseSourceIndex(Buffer.from(indexText.replace(firstRecord, ""))),
    ).toThrow("source input count mismatch");
    expect(() =>
      parseSourceIndex(
        Buffer.from(
          indexText.replace(firstRecord, firstRecord.replace("100644", "120000")),
        ),
      ),
    ).toThrow("source input mode is not 100644");
    expect(() =>
      parseSourceIndex(
        Buffer.from(
          indexText.replace(firstRecord, firstRecord.replace(" 0\t", " 1\t")),
        ),
      ),
    ).toThrow("non-stage-zero source input");
    expect(() =>
      parseSourceIndex(
        Buffer.from(
          indexText.replace(
            firstRecord,
            firstRecord.replace(first.object, "0".repeat(40)),
          ),
        ),
      ),
    ).toThrow("source input object mismatch");
    expect(() =>
      parseSourceIndex(
        Buffer.concat([
          index,
          Buffer.from(
            `100644 ${"0".repeat(40)} 0\ttools/hosted-migration-preparation-proof/src/extra.rs\0`,
          ),
        ]),
      ),
    ).toThrow("extra source input");

    const changedBytes = new Map(bytes);
    changedBytes.set(
      first.path,
      Buffer.concat([changedBytes.get(first.path) ?? Buffer.alloc(0), Buffer.of(0)]),
    );
    expect(() => buildSourceLedgerRows(records, changedBytes)).toThrow(
      "source bytes do not match indexed object",
    );
    const missingBytes = new Map(bytes);
    missingBytes.delete(first.path);
    expect(() => buildSourceLedgerRows(records, missingBytes)).toThrow(
      "source byte inventory mismatch",
    );
    const extraBytes = new Map(bytes);
    extraBytes.set("tools/hosted-migration-root-authority/src/extra.rs", Buffer.alloc(0));
    expect(() => buildSourceLedgerRows(records, extraBytes)).toThrow(
      "source byte inventory mismatch",
    );

    const sourceLedger = buildSourceLedgerRows(records, bytes);
    const changedLedger = Buffer.from(sourceLedger.ledgerRows, "utf8");
    changedLedger[0] = (changedLedger[0] ?? 0) ^ 1;
    expect(() => verifySourceLedgerRows(records, bytes, changedLedger)).toThrow(
      "source ledger byte mismatch",
    );
  });

  it("stages and re-proves the fixed source tree through an exact open destination", async () => {
    const index = sourceIndexBytes();
    const fixture = await copiedCargoModule(index);
    const destination = createInvocationDestination();
    const handle = await open(
      destination.source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const result = await fixture.module.stageFixedSourceSnapshot({
        indexBytes: index,
        sourceDirectory: handle,
      });
      expect(result).toMatchObject({
        files: 45,
        directories: 10,
        regularFileBytes: 1_283_730,
        records: 55,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(lstatSync(destination.source).mode & 0o7777).toBe(0o555);
      expect(
        lstatSync(
          join(destination.source, "tools/hosted-migration-root-authority/src/lib.rs"),
        ).mode & 0o7777,
      ).toBe(0o444);
      expect(
        readFileSync(
          join(destination.source, "tools/hosted-migration-root-authority/src/lib.rs"),
        ),
      ).toEqual(
        readFileSync(
          join(fixture.directory, "tools/hosted-migration-root-authority/src/lib.rs"),
        ),
      );
    } finally {
      await handle.close();
      removeFixture(destination.invocation);
      removeFixture(fixture.directory);
    }
  });

  it("stages the actual fixed workspace without changing its checkout modes", async () => {
    const destination = createInvocationDestination();
    const handle = await open(
      destination.source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const result = await stageFixedSourceSnapshot({
        indexBytes: sourceIndexBytes(),
        sourceDirectory: handle,
      });
      expect(result).toMatchObject({
        files: 45,
        directories: 10,
        regularFileBytes: 1_283_730,
        records: 55,
      });
    } finally {
      await handle.close();
      removeFixture(destination.invocation);
    }
  });

  it("refuses isolated untracked, link, special, and mode substitutions", async () => {
    const index = sourceIndexBytes();
    const cases = [
      {
        expected: "untracked source file",
        mutate(directory: string): void {
          writeFileSync(
            join(directory, "tools/hosted-migration-root-authority/src/untracked.rs"),
            "fn untracked() {}\n",
          );
        },
      },
      {
        expected: "untracked source directory",
        mutate(directory: string): void {
          mkdirSync(
            join(directory, "tools/hosted-migration-runtime-proof/src/empty-untracked"),
          );
        },
      },
      {
        expected: "link or special source entry",
        mutate(directory: string): void {
          const selected = join(
            directory,
            "tools/hosted-migration-root-authority/src/lib.rs",
          );
          const sameBytes = join(directory, "same-bytes-lib.rs");
          copyFileSync(selected, sameBytes);
          rmSync(selected);
          symlinkSync(sameBytes, selected);
        },
      },
      {
        expected: "link or special source entry",
        mutate(directory: string): void {
          execFileSync("/usr/bin/mkfifo", [
            join(directory, "tools/hosted-migration-runtime-proof/src/untracked.rs"),
          ]);
        },
      },
      {
        expected: "source bytes do not match indexed object",
        mutate(directory: string): void {
          appendFileSync(
            join(directory, "tools/hosted-migration-runtime-proof/src/lib.rs"),
            "\n",
          );
        },
      },
    ] as const;

    for (const adversarial of cases) {
      const fixture = await copiedCargoModule(index);
      const destination = createInvocationDestination();
      const handle = await open(
        destination.source,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        adversarial.mutate(fixture.directory);
        await expect(
          fixture.module.stageFixedSourceSnapshot({
            indexBytes: index,
            sourceDirectory: handle,
          }),
        ).rejects.toThrow(adversarial.expected);
      } finally {
        await handle.close();
        removeFixture(destination.invocation);
        removeFixture(fixture.directory);
      }
    }
  });

  it("accepts workspace permission variation without weakening byte identity", async () => {
    const index = sourceIndexBytes();
    for (const mode of [0o400, 0o666, 0o700]) {
      const fixture = await copiedCargoModule(index);
      const destination = createInvocationDestination();
      const handle = await open(
        destination.source,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        chmodSync(
          join(fixture.directory, "tools/hosted-migration-runtime-proof/src/lib.rs"),
          mode,
        );
        const result = await fixture.module.stageFixedSourceSnapshot({
          indexBytes: index,
          sourceDirectory: handle,
        });
        expect(result.files).toBe(45);
        expect(
          lstatSync(
            join(destination.source, "tools/hosted-migration-runtime-proof/src/lib.rs"),
          ).mode & 0o7777,
        ).toBe(0o444);
      } finally {
        await handle.close();
        removeFixture(destination.invocation);
        removeFixture(fixture.directory);
      }
    }
  });

  it("refuses a symlink substituted for an exact package-root component", async () => {
    const index = sourceIndexBytes();
    const fixture = await copiedCargoModule(index);
    const destination = createInvocationDestination();
    const handle = await open(
      destination.source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const packageRoot = join(fixture.directory, "tools/hosted-migration-runtime-proof");
      const relocated = join(fixture.directory, "runtime-proof-relocated");
      renameSync(packageRoot, relocated);
      symlinkSync(relocated, packageRoot, "dir");
      await expect(
        fixture.module.stageFixedSourceSnapshot({
          indexBytes: index,
          sourceDirectory: handle,
        }),
      ).rejects.toThrow();
      expect(lstatSync(packageRoot).isSymbolicLink()).toBe(true);
    } finally {
      await handle.close();
      removeFixture(destination.invocation);
      removeFixture(fixture.directory);
    }
  });

  it("binds the live workspace mount and refuses a synthetic same-device bind", async () => {
    expect(
      assertNoFixedWorkspaceMountpoints(readFileSync("/proc/self/mountinfo")).length,
    ).toBeGreaterThan(0);

    const index = sourceIndexBytes();
    const fixture = await copiedCargoModule(index);
    try {
      const synthetic = Buffer.from(
        [
          "1 0 8:1 / / rw - ext4 /dev/root rw",
          `2 1 8:1 / ${fixture.directory} rw - ext4 /dev/root rw`,
          "",
        ].join("\n"),
      );
      expect(() => fixture.module.assertNoFixedWorkspaceMountpoints(synthetic)).toThrow(
        "mountpoint in fixed workspace ancestry",
      );
    } finally {
      removeFixture(fixture.directory);
    }
  });

  it("keeps writes on its owned root after the caller fd is closed and reused", async () => {
    const destinationA = createInvocationDestination();
    const destinationB = createInvocationDestination();
    const callerHandle = await open(
      destinationA.source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const callerDescriptor = callerHandle.fd;
    let callerClosed = false;
    let reusedDescriptor: number | undefined;
    let staging: ReturnType<typeof stageFixedSourceSnapshot> | undefined;
    try {
      staging = stageFixedSourceSnapshot({
        indexBytes: sourceIndexBytes(),
        sourceDirectory: callerHandle,
      });
      closeSync(callerDescriptor);
      callerClosed = true;
      reusedDescriptor = openSync(
        destinationB.source,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      expect(reusedDescriptor).toBe(callerDescriptor);
      await expect(staging).resolves.toMatchObject({ files: 45, directories: 10 });
      expect(readdirSync(destinationB.source)).toEqual([]);
      expect(existsSync(join(destinationA.source, "tools"))).toBe(true);
    } finally {
      if (staging !== undefined) await staging.catch(() => undefined);
      if (reusedDescriptor !== undefined) closeSync(reusedDescriptor);
      if (callerClosed) await callerHandle.close().catch(() => undefined);
      else await callerHandle.close();
      removeFixture(destinationA.invocation);
      removeFixture(destinationB.invocation);
    }
  });

  it("refuses a structurally spoofed destination handle", async () => {
    const destination = createInvocationDestination();
    const handle = await open(
      destination.source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const spoof = {
        fd: handle.fd,
        async chmod(): Promise<void> {},
        async stat(): Promise<never> {
          throw new Error("spoof stat must not be called");
        },
        async sync(): Promise<void> {},
      };
      await expect(
        stageFixedSourceSnapshot({
          indexBytes: sourceIndexBytes(),
          sourceDirectory: spoof,
        }),
      ).rejects.toThrow("actual FileHandle source destination required");
    } finally {
      await handle.close();
      removeFixture(destination.invocation);
    }
  });

  it("refuses an invocation record that does not bind the directory name", async () => {
    const destination = createInvocationDestination();
    const recordPath = join(destination.invocation, "INVOCATION");
    const record = readFileSync(recordPath);
    record[0] = (record[0] ?? 0) ^ 1;
    writeFileSync(recordPath, record);
    const handle = await open(
      destination.source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await expect(
        stageFixedSourceSnapshot({
          indexBytes: sourceIndexBytes(),
          sourceDirectory: handle,
        }),
      ).rejects.toThrow("invocation record byte mismatch");
      expect(readdirSync(destination.source)).toEqual([]);
    } finally {
      await handle.close();
      removeFixture(destination.invocation);
    }
  });

  it("enforces the branded 300-plus-25-second fresh-root construction budget", () => {
    const start = 41_000_000_000n;
    const initial = createFreshRootCopyBudget(start);
    expect(initial).toEqual({
      activeDeadlineNanoseconds: start + 300_000_000_000n,
      cleanupDeadlineNanoseconds: start + 315_000_000_000n,
      cleanupState: "uncreated",
      hardDeadlineNanoseconds: start + 325_000_000_000n,
      lastNanoseconds: start,
      phase: "active",
      startNanoseconds: start,
    });
    const created = advanceFreshRootCopyBudget(initial, "directory-created", start + 1n);
    const recorded = advanceFreshRootCopyBudget(created, "record-synced", start + 2n);
    const verified = advanceFreshRootCopyBudget(recorded, "ledger-verified", start + 3n);
    expect([created.cleanupState, recorded.cleanupState, verified.cleanupState]).toEqual([
      "pre-record",
      "partial-acquisition",
      "ledger-backed",
    ]);
    expect(() => advanceFreshRootCopyBudget({ ...initial }, "work", start + 1n)).toThrow(
      "unbranded fresh-root copy budget",
    );
    expect(() => advanceFreshRootCopyBudget(initial, "record-synced", start + 1n)).toThrow(
      "invalid fresh-root construction transition",
    );
    expect(() => advanceFreshRootCopyBudget(initial, "work", start - 1n)).toThrow(
      "CLOCK_BOOTTIME regressed",
    );
    expect(() =>
      advanceFreshRootCopyBudget(initial, "work", initial.activeDeadlineNanoseconds),
    ).toThrow("active deadline reached");
    const cleanup = advanceFreshRootCopyBudget(
      initial,
      "cleanup-start",
      initial.activeDeadlineNanoseconds + 1n,
    );
    expect(cleanup.phase).toBe("cleanup");
    const cleaning = advanceFreshRootCopyBudget(
      cleanup,
      "cleanup-work",
      cleanup.cleanupDeadlineNanoseconds - 2n,
    );
    const reserve = advanceFreshRootCopyBudget(
      cleaning,
      "cleanup-settled",
      cleanup.cleanupDeadlineNanoseconds - 1n,
    );
    expect(reserve.phase).toBe("reserve");
    expect(
      advanceFreshRootCopyBudget(
        reserve,
        "reserve",
        reserve.hardDeadlineNanoseconds - 1n,
      ).phase,
    ).toBe("reserve");
    expect(() =>
      advanceFreshRootCopyBudget(cleanup, "cleanup-work", cleanup.cleanupDeadlineNanoseconds),
    ).toThrow("cleanup deadline reached");
    expect(() =>
      advanceFreshRootCopyBudget(initial, "work", initial.hardDeadlineNanoseconds),
    ).toThrow("hard deadline reached");
  });

  it("samples the held boot clock after mkdir and around both exact EOF probes", () => {
    const source = readFileSync(join(packageDirectory, "scripts/cargo.mjs"), "utf8");
    expect(source).toContain(
      `destination = Object.freeze({ cleanupKind: "identity-uncertain", destinationPath: path, parent });\n      advanceHeldFreshRootBudget(budgetState, "work", clock);\n      const reached = lstatSync(path, { bigint: true });`,
    );
    expect(source).toContain(
      `advanceHeldFreshRootBudget(budgetState, "work", clock);\n    if ((await handle.read(probe, 0, 1, expected.size)).bytesRead !== 0) {\n      throw new Error("ledger-backed source grew during read");\n    }\n    advanceHeldFreshRootBudget(budgetState, "work", clock);`,
    );
    expect(source).toContain(
      `advanceHeldFreshRootBudget(budgetState, "work", clock);\n  if (readSync(descriptor, buffer, 0, 1, expected.size) !== 0)`,
    );
    expect(source).toContain(
      `throw new Error("fresh-root retained ledger grew during read");\n  }\n  advanceHeldFreshRootBudget(budgetState, "work", clock);`,
    );
  });

  it("refuses a helper close first observed at or beyond its exact slot boundary", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { exposeCleanupPollClassifier: true }),
    );
    try {
      const classify = fixtureModule.module.fixtureClassifyCleanupChildPoll;
      expect(classify).toBeTypeOf("function");
      expect(classify?.(false, 3_999_999_999n, 4_000_000_000n)).toBe("waiting");
      expect(classify?.(true, 3_999_999_999n, 4_000_000_000n)).toBe("closed");
      expect(classify?.(true, 4_000_000_000n, 4_000_000_000n)).toBe("expired");
      expect(classify?.(true, 4_000_000_001n, 4_000_000_000n)).toBe("expired");
    } finally {
      removeFixture(fixtureModule.directory);
    }
  });

  it("settles the held boot clock when initial sampling or entropy fails", async () => {
    const compact = compactCompleteFixture();
    for (const initialFailure of ["sample", "random"] as const) {
      const fixtureModule = await copiedCargoModule(
        sourceIndexBytes(),
        compactFixtureTransform(compact, { initialFailure }),
      );
      try {
        const before = openBootClockDescriptors();
        await expect(fixtureModule.module.prepareFreshLedgerBackedRoot()).rejects.toThrow(
          initialFailure === "sample" ? "initial sample failure" : "entropy failure",
        );
        expect(openBootClockDescriptors()).toBe(before);
      } finally {
        removeFixture(fixtureModule.directory);
      }
    }
  });

  it("copies and independently re-proves one compact authenticated complete tree", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let copiedPath: string | undefined;
    let reusedCallerDescriptor: number | undefined;
    let sourceCallerClosed = false;
    const descriptors: number[] = [];
    let launchedChild: ReturnType<typeof fixtureModule.module.launchBeforeIssueFreshRoot>["child"];
    try {
      const pending = fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      const callerDescriptor = source.sourceHandle.fd;
      closeSync(callerDescriptor);
      sourceCallerClosed = true;
      reusedCallerDescriptor = openSync(
        fixtureModule.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      expect(reusedCallerDescriptor).toBe(callerDescriptor);
      const token = await pending;
      const launch = fixtureModule.module.launchBeforeIssueFreshRoot(token);
      launchedChild = launch.child;
      const handoff = { ...launch.cleanup, ...launch.custody };
      const verifiedCopiedPath = launch.cleanup.path;
      copiedPath = verifiedCopiedPath;
      descriptors.push(handoff.custodyRoot, handoff.ledgerDescriptor);
      expect(Object.isFrozen(token)).toBe(true);
      expect(Object.isFrozen(launch)).toBe(true);
      expect(launch.outcome).toBe("spawned");
      expect(launch.child?.spawnfile).toBe(process.execPath);
      expect(launch.child?.spawnargs).toEqual([
        process.execPath,
        join(
          fixtureModule.directory,
          "tools/hosted-migration-preparation-proof/scripts/child-containment-launcher.mjs",
        ),
      ]);
      expect(handoff).toMatchObject({
        ledgerDigest: sha256(compact.ledger),
        ledgerSize: compact.ledger.length,
        parentToken: "tmp",
      });
      expect(handoff.invocation).not.toBe(source.invocation.slice(source.invocation.lastIndexOf("-") + 1));
      expect(readFileSync(join(verifiedCopiedPath, "INVOCATION"), "ascii")).toBe(
        `openspell.wp201.invocation.v1\n${handoff.invocation}\n`,
      );
      expect(readFileSync(join(verifiedCopiedPath, "acquisition/vendor-ledger.v1"))).toEqual(
        compact.ledger,
      );

      const sourceSnapshot = completeTreeSnapshot(source.invocation);
      const copiedSnapshot = completeTreeSnapshot(verifiedCopiedPath);
      expect(sourceSnapshot.size).toBe(212);
      expect(copiedSnapshot.size).toBe(sourceSnapshot.size);
      expect([...copiedSnapshot.keys()]).toEqual([...sourceSnapshot.keys()]);
      for (const [path, expected] of sourceSnapshot) {
        const actual = copiedSnapshot.get(path);
        expect(actual).toBeDefined();
        expect(actual?.kind).toBe(expected.kind);
        expect(actual?.mode).toBe(expected.mode);
        expect(actual?.size).toBe(expected.size);
        if (path === "INVOCATION") {
          expect(actual?.digest).not.toBe(expected.digest);
        } else {
          expect(actual?.digest).toBe(expected.digest);
        }
        expect(actual?.inode).not.toBe(expected.inode);
      }
      expect("handoffRoot" in launch.custody).toBe(false);
      expect(() => fixtureModule.module.launchBeforeIssueFreshRoot(token)).toThrow(
        "invalid or consumed",
      );
      expect(() =>
        fixtureModule.module.launchAfterDaemonAcceptBeforeDeliveryFreshRoot(token),
      ).toThrow("invalid or consumed");
      expect(() =>
        fixtureModule.module.launchAfterParentCustodyBeforeStartFreshRoot(token),
      ).toThrow("invalid or consumed");
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).rejects.toThrow(
        "invalid or consumed",
      );
    } finally {
      if (launchedChild !== undefined) {
        await settleCopiedContainedChild(fixtureModule.directory, launchedChild);
      }
      for (const descriptor of descriptors.reverse()) closeSync(descriptor);
      if (reusedCallerDescriptor !== undefined) closeSync(reusedCallerDescriptor);
      if (sourceCallerClosed) await source.sourceHandle.close().catch(() => undefined);
      else await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("rejects complete-tree links, special files, mode drift, and digest drift", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    const acquisition = join(source.invocation, "acquisition");
    try {
      const link = join(acquisition, "unexpected-link");
      symlinkSync("vendor", link);
      await expect(
        fixtureModule.module.prepareFreshLedgerBackedRoot({ sourceDirectory: source.sourceHandle }),
      ).rejects.toThrow("link or special ledger-backed entry");
      rmSync(link);

      const fifo = join(acquisition, "unexpected-fifo");
      execFileSync("/usr/bin/mkfifo", [fifo]);
      await expect(
        fixtureModule.module.prepareFreshLedgerBackedRoot({ sourceDirectory: source.sourceHandle }),
      ).rejects.toThrow("link or special ledger-backed entry");
      rmSync(fifo);

      const controller = join(source.invocation, "control/proof.sh");
      chmodSync(controller, 0o544);
      await expect(
        fixtureModule.module.prepareFreshLedgerBackedRoot({ sourceDirectory: source.sourceHandle }),
      ).rejects.toThrow("ledger-backed file identity mismatch");
      chmodSync(controller, 0o444);
      const original = readFileSync(controller);
      chmodSync(controller, 0o644);
      writeFileSync(controller, Buffer.concat([original.subarray(0, -1), Buffer.from("x")]));
      chmodSync(controller, 0o444);
      await expect(
        fixtureModule.module.prepareFreshLedgerBackedRoot({ sourceDirectory: source.sourceHandle }),
      ).rejects.toThrow("ledger-backed file digest mismatch");
    } finally {
      await source.sourceHandle.close();
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("abandons a fresh-root token exactly once and returns its cleanup identity", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let copiedPath: string | undefined;
    try {
      const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      const cleanup = await fixtureModule.module.abandonFreshRootHandoff(token);
      copiedPath = cleanup.path;
      expect(cleanup).toMatchObject({ parentToken: "tmp", state: "ledger-backed" });
      expect(lstatSync(cleanup.path, { bigint: true })).toMatchObject({
        dev: cleanup.device,
        ino: cleanup.inode,
      });
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).rejects.toThrow(
        "invalid or consumed",
      );
      expect(() => fixtureModule.module.launchBeforeIssueFreshRoot(token)).toThrow(
        "invalid or consumed",
      );
    } finally {
      await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("retains an abandonment token until every private descriptor settles", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { firstDescriptorCloseFailure: true }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let copiedPath: string | undefined;
    try {
      const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      let failure: unknown;
      try {
        await fixtureModule.module.abandonFreshRootHandoff(token);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      const settlement = failure as AggregateError & {
        readonly cleanup: { readonly path: string; readonly state: string };
        readonly unsettled: readonly { readonly name: string; readonly settled: boolean }[];
      };
      copiedPath = settlement.cleanup.path;
      expect(settlement.cleanup.state).toBe("ledger-backed");
      expect(settlement.unsettled).toMatchObject([
        { name: "ledgerDescriptor", settled: false },
      ]);
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).resolves.toMatchObject({
        path: copiedPath,
        state: "ledger-backed",
      });
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).rejects.toThrow(
        "invalid or consumed",
      );
    } finally {
      await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("never closes an unrelated descriptor that reused an ambiguously closed fd", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { exposeDescriptorSettlement: true }),
    );
    const firstPath = join(fixtureModule.directory, "first-descriptor");
    const secondPath = join(fixtureModule.directory, "second-descriptor");
    writeFileSync(firstPath, "first", { mode: 0o600 });
    writeFileSync(secondPath, "second", { mode: 0o600 });
    const firstDescriptor = openSync(firstPath, constants.O_RDONLY);
    const firstIdentity = fstatSync(firstDescriptor, { bigint: true });
    const firstMount = readFileSync(`/proc/self/fdinfo/${firstDescriptor}`, "ascii")
      .match(/^mnt_id:\s+(?<mount>[0-9]+)$/mu)?.groups?.mount;
    expect(firstMount).toBeDefined();
    closeSync(firstDescriptor);
    let matchingA: number | undefined;
    let matchingB: number | undefined;
    let reusedDescriptor: number | undefined;
    try {
      reusedDescriptor = openSync(secondPath, constants.O_RDONLY);
      expect(reusedDescriptor).toBe(firstDescriptor);
      matchingA = openSync(firstPath, constants.O_RDONLY);
      matchingB = openSync(firstPath, constants.O_RDONLY);
      const settle = fixtureModule.module.fixtureSettlePrivateDescriptorIdentity;
      expect(settle).toBeTypeOf("function");
      const expected = {
        device: firstIdentity.dev,
        gid: firstIdentity.gid,
        inode: firstIdentity.ino,
        mountId: firstMount ?? "0",
        uid: firstIdentity.uid,
      };
      expect(settle?.(expected, [matchingA])).toMatchObject({
        observedMatches: 2,
        protectedMatches: 1,
        remainingMatches: 0,
        settled: true,
      });
      expect(readFileSync(`/proc/self/fd/${matchingA}`, "utf8")).toBe("first");
      expect(() => fstatSync(matchingB ?? -1)).toThrow();
      expect(readFileSync(`/proc/self/fd/${reusedDescriptor}`, "utf8")).toBe("second");
      const finalSettlement = settle?.(expected);
      expect(finalSettlement).toMatchObject({
        observedMatches: 1,
        protectedMatches: 0,
        remainingMatches: 0,
        settled: true,
      });
      expect(() => fstatSync(matchingA ?? -1)).toThrow();
      const absentSettlement = settle?.(expected);
      expect(absentSettlement).toMatchObject({
        observedMatches: 0,
        protectedMatches: 0,
        remainingMatches: 0,
        settled: true,
      });
      expect(readFileSync(`/proc/self/fd/${reusedDescriptor}`, "utf8")).toBe("second");
    } finally {
      if (matchingB !== undefined) {
        try { closeSync(matchingB); } catch { /* identity settlement already closed it */ }
      }
      if (matchingA !== undefined) {
        try { closeSync(matchingA); } catch { /* identity settlement already closed it */ }
      }
      if (reusedDescriptor !== undefined) closeSync(reusedDescriptor);
      removeFixture(fixtureModule.directory);
    }
  });

  it("settles a failed handoff close without consuming retained custody", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { firstDescriptorCloseFailure: true }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let copiedPath: string | undefined;
    let child: ReturnType<typeof fixtureModule.module.launchBeforeIssueFreshRoot>["child"];
    let custodyRoot: number | undefined;
    let ledgerDescriptor: number | undefined;
    try {
      const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      let failure: unknown;
      try {
        fixtureModule.module.launchBeforeIssueFreshRoot(token);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const handoffFailure = failure as Error;
      for (const name of [
        "child",
        "cleanup",
        "custody",
        "handoffSettlementToken",
        "unsettled",
      ]) {
        expect(Object.getOwnPropertyDescriptor(handoffFailure, name)).toBeUndefined();
      }
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).rejects.toThrow(
        "invalid or consumed",
      );
      const claimed = fixtureModule.module.claimFreshRootHandoffFailure(handoffFailure);
      expect(claimed).toBeDefined();
      child = claimed!.launch.child;
      copiedPath = claimed!.launch.cleanup.path;
      custodyRoot = claimed!.launch.custody.custodyRoot;
      ledgerDescriptor = claimed!.launch.custody.ledgerDescriptor;
      const settlement = claimed!.handoffSettlement;
      expect(settlement).toMatchObject({
        observedMatches: 2,
        protectedMatches: 1,
        remainingMatches: 0,
        settled: true,
      });
      expect(settlement).not.toHaveProperty("descriptor");
      expect(settlement).not.toHaveProperty("observed");
      expect(settlement).not.toHaveProperty("remaining");
      expect(fixtureModule.module.claimFreshRootHandoffFailure(handoffFailure)).toBeUndefined();
      expect(fixtureModule.module.claimFreshRootHandoffFailure(new Error("forged"))).toBeUndefined();
      expect(fstatSync(claimed!.launch.custody.custodyRoot, { bigint: true }).isDirectory()).toBe(true);
      expect(readFileSync(`/proc/self/fd/${claimed!.launch.custody.ledgerDescriptor}`)).toEqual(
        compact.ledger,
      );
    } finally {
      if (child !== undefined) await settleCopiedContainedChild(fixtureModule.directory, child);
      if (ledgerDescriptor !== undefined) closeSync(ledgerDescriptor);
      if (custodyRoot !== undefined) closeSync(custodyRoot);
      await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("preserves ordered close and probe failures while a clean retry settles custody", async () => {
    for (const spawnFailure of [false, true]) {
      const compact = compactCompleteFixture();
      const fixtureModule = await copiedCargoModule(
        sourceIndexBytes(),
        compactFixtureTransform(compact, {
          firstDescriptorCloseFailure: true,
          firstDescriptorProbeFailure: true,
          spawnFailure,
        }),
      );
      const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
      let child: ReturnType<typeof fixtureModule.module.launchBeforeIssueFreshRoot>["child"];
      let copiedPath: string | undefined;
      let custodyRoot: number | undefined;
      let ledgerDescriptor: number | undefined;
      try {
        const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
          sourceDirectory: source.sourceHandle,
        });
        let caught: unknown;
        try {
          fixtureModule.module.launchBeforeIssueFreshRoot(token);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(AggregateError);
        const failure = caught as AggregateError;
        const expected = spawnFailure
          ? [
              fixtureModule.module.fixtureSpawnError,
              fixtureModule.module.fixtureDescriptorCloseError,
              fixtureModule.module.fixtureDescriptorProbeError,
            ]
          : [
              fixtureModule.module.fixtureDescriptorCloseError,
              fixtureModule.module.fixtureDescriptorProbeError,
            ];
        expect(failure.errors).toEqual(expected);
        expect(failure.cause).toBe(expected[0]);
        const claimed = fixtureModule.module.claimFreshRootHandoffFailure(failure);
        expect(claimed).toBeDefined();
        expect(claimed?.handoffSettlement).toMatchObject({ settled: true });
        expect(claimed?.recoveryFailure).toBeUndefined();
        child = claimed?.launch.child;
        copiedPath = claimed?.launch.cleanup.path;
        custodyRoot = claimed?.launch.custody.custodyRoot;
        ledgerDescriptor = claimed?.launch.custody.ledgerDescriptor;
        expect(fixtureModule.module.claimFreshRootHandoffFailure(failure)).toBeUndefined();
      } finally {
        if (child !== undefined) await settleCopiedContainedChild(fixtureModule.directory, child);
        if (ledgerDescriptor !== undefined) closeSync(ledgerDescriptor);
        if (custodyRoot !== undefined) closeSync(custodyRoot);
        await source.sourceHandle.close();
        if (copiedPath !== undefined) removeFixture(copiedPath);
        removeFixture(source.invocation);
        removeFixture(fixtureModule.directory);
      }
    }
  });

  it("returns the exact synchronous spawn error with authenticated cleanup custody", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { spawnFailure: true }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let copiedPath: string | undefined;
    let custodyRoot: number | undefined;
    let ledgerDescriptor: number | undefined;
    try {
      const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      const launch = fixtureModule.module.launchBeforeIssueFreshRoot(token);
      copiedPath = launch.cleanup.path;
      custodyRoot = launch.custody.custodyRoot;
      ledgerDescriptor = launch.custody.ledgerDescriptor;
      expect(launch).toMatchObject({ child: undefined, outcome: "synchronous-spawn-failure" });
      expect(launch.spawnError).toBe(fixtureModule.module.fixtureSpawnError);
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).rejects.toThrow(
        "invalid or consumed",
      );
    } finally {
      if (ledgerDescriptor !== undefined) closeSync(ledgerDescriptor);
      if (custodyRoot !== undefined) closeSync(custodyRoot);
      await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("privately preserves recovery custody when contained release fails", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { releaseFailure: true }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let child: ReturnType<typeof fixtureModule.module.launchBeforeIssueFreshRoot>["child"];
    let copiedPath: string | undefined;
    let custodyRoot: number | undefined;
    let ledgerDescriptor: number | undefined;
    try {
      const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      let caught: unknown;
      try {
        fixtureModule.module.launchBeforeIssueFreshRoot(token);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(fixtureModule.module.fixtureReleaseError);
      await expect(fixtureModule.module.abandonFreshRootHandoff(token)).rejects.toThrow(
        "invalid or consumed",
      );
      const claimed = fixtureModule.module.claimFreshRootHandoffFailure(caught);
      expect(claimed).toBeDefined();
      expect(claimed?.handoffSettlement).toMatchObject({ settled: true });
      expect(claimed?.recoveryFailure).toBeUndefined();
      expect(claimed?.launch.outcome).toBe("spawned");
      child = claimed?.launch.child;
      copiedPath = claimed?.launch.cleanup.path;
      custodyRoot = claimed?.launch.custody.custodyRoot;
      ledgerDescriptor = claimed?.launch.custody.ledgerDescriptor;
      expect(fixtureModule.module.claimFreshRootHandoffFailure(caught)).toBeUndefined();
      expect(fixtureModule.module.claimFreshRootHandoffFailure(new Error("forged"))).toBeUndefined();
    } finally {
      if (child !== undefined) await settleCopiedContainedChild(fixtureModule.directory, child);
      if (ledgerDescriptor !== undefined) closeSync(ledgerDescriptor);
      if (custodyRoot !== undefined) closeSync(custodyRoot);
      await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("orders contained release and abort failures under the exact release cause", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, { abortFailure: true, releaseFailure: true }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    let child: ReturnType<typeof fixtureModule.module.launchBeforeIssueFreshRoot>["child"];
    let copiedPath: string | undefined;
    let custodyRoot: number | undefined;
    let ledgerDescriptor: number | undefined;
    try {
      const token = await fixtureModule.module.prepareFreshLedgerBackedRoot({
        sourceDirectory: source.sourceHandle,
      });
      let caught: unknown;
      try {
        fixtureModule.module.launchBeforeIssueFreshRoot(token);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const failure = caught as AggregateError;
      expect(failure.errors).toEqual([
        fixtureModule.module.fixtureReleaseError,
        fixtureModule.module.fixtureAbortError,
      ]);
      expect(failure.cause).toBe(fixtureModule.module.fixtureReleaseError);
      const claimed = fixtureModule.module.claimFreshRootHandoffFailure(failure);
      expect(claimed).toBeDefined();
      child = claimed?.launch.child;
      copiedPath = claimed?.launch.cleanup.path;
      custodyRoot = claimed?.launch.custody.custodyRoot;
      ledgerDescriptor = claimed?.launch.custody.ledgerDescriptor;
      expect(fixtureModule.module.claimFreshRootHandoffFailure(failure)).toBeUndefined();
    } finally {
      if (child !== undefined) await settleCopiedContainedChild(fixtureModule.directory, child);
      if (ledgerDescriptor !== undefined) closeSync(ledgerDescriptor);
      if (custodyRoot !== undefined) closeSync(custodyRoot);
      await source.sourceHandle.close();
      if (copiedPath !== undefined) removeFixture(copiedPath);
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("reports authenticated partial-acquisition cleanup state after a post-record failure", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, {
        afterInvocationSync: 'throw new Error("fixture post-record failure");',
      }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    try {
      let failure: unknown;
      try {
        await fixtureModule.module.prepareFreshLedgerBackedRoot({
          sourceDirectory: source.sourceHandle,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("fixture post-record failure");
      const cleanup = (failure as Error & {
        readonly cleanup?: { readonly outcome: string; readonly path: string; readonly state: string };
      }).cleanup;
      expect(cleanup).toMatchObject({
        outcome: "helper-complete-and-parent-absent",
        state: "partial-acquisition",
      });
      expect(cleanup?.path).toMatch(/^\/tmp\/openspell-wp201-root-proof-[0-9a-f]{64}$/u);
      expect(existsSync(cleanup?.path ?? "missing")).toBe(false);
    } finally {
      await source.sourceHandle.close();
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("latches a post-create signal and removes the authenticated partial tree", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, {
        afterInvocationSync: "globalThis.wp201FixtureAbort.abort();",
      }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    const controller = new AbortController();
    (globalThis as unknown as { wp201FixtureAbort: AbortController }).wp201FixtureAbort = controller;
    try {
      let failure: unknown;
      try {
        await fixtureModule.module.prepareFreshLedgerBackedRoot({
          signal: controller.signal,
          sourceDirectory: source.sourceHandle,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("signal latched");
      const cleanup = (failure as Error & {
        readonly cleanup?: { readonly outcome: string; readonly path: string; readonly state: string };
      }).cleanup;
      expect(cleanup).toMatchObject({
        outcome: "helper-complete-and-parent-absent",
        state: "partial-acquisition",
      });
      expect(existsSync(cleanup?.path ?? "missing")).toBe(false);
    } finally {
      delete (globalThis as unknown as { wp201FixtureAbort?: AbortController }).wp201FixtureAbort;
      await source.sourceHandle.close();
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("records and safely settles pre-record cleanup immediately after mkdir", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, {
        afterDirectoryCreate: 'throw new Error("fixture post-mkdir failure");',
      }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    try {
      let failure: unknown;
      try {
        await fixtureModule.module.prepareFreshLedgerBackedRoot({
          sourceDirectory: source.sourceHandle,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("fixture post-mkdir failure");
      const cleanup = (failure as Error & {
        readonly cleanup?: {
          readonly helperUsable: boolean;
          readonly kind: string;
          readonly path: string;
          readonly state: string;
        };
      }).cleanup;
      expect(cleanup).toMatchObject({
        helperUsable: false,
        kind: "settled-pre-record",
        state: "pre-record",
      });
      expect(cleanup?.path).toMatch(/^\/tmp\/openspell-wp201-root-proof-[0-9a-f]{64}$/u);
      expect(existsSync(cleanup?.path ?? "missing")).toBe(false);
      expect(cleanup).not.toHaveProperty("device");
      expect(cleanup).not.toHaveProperty("inode");
      expect(cleanup).not.toHaveProperty("mountId");
    } finally {
      await source.sourceHandle.close();
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("re-verifies the authenticated source after the destination copy completes", async () => {
    const compact = compactCompleteFixture();
    const fixtureModule = await copiedCargoModule(
      sourceIndexBytes(),
      compactFixtureTransform(compact, {
        beforeSettledSourceVerification:
          'await chmod(join(source.descriptorPath, "control/proof.sh"), 0o544);',
      }),
    );
    const source = await createCompleteInvocationFixture(fixtureModule.module, compact);
    try {
      let failure: unknown;
      try {
        await fixtureModule.module.prepareFreshLedgerBackedRoot({
          sourceDirectory: source.sourceHandle,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("ledger-backed file identity mismatch");
      const cleanup = (failure as Error & {
        readonly cleanup?: {
          readonly helperUsable: boolean;
          readonly kind: string;
          readonly outcome: string;
          readonly path: string;
          readonly state: string;
        };
      }).cleanup;
      expect(cleanup).toMatchObject({
        helperUsable: true,
        kind: "authenticated",
        outcome: "helper-complete-and-parent-absent",
        state: "partial-acquisition",
      });
      expect(existsSync(cleanup?.path ?? "missing")).toBe(false);
    } finally {
      chmodSync(join(source.invocation, "control/proof.sh"), 0o444);
      await source.sourceHandle.close();
      removeFixture(source.invocation);
      removeFixture(fixtureModule.directory);
    }
  });

  it("normalizes manifest escapes before dependency-boundary checks", () => {
    expect(
      normalizedManifestText(
        'openspell\\u002Dhosted\\u002Dmigration\\u002Droot\\u002Dauthority = "x"',
      ),
    ).toContain(rootAuthorityCargoName);
    expect(
      normalizedManifestText(
        'openspell\\U0000002Dhosted\\U0000002Dmigration\\U0000002Druntime\\\n\n  \\U0000002Dproof = "x"',
      ),
    ).toContain(runtimeProofCargoName);
    expect(
      normalizedManifestText('file:../../tools/hosted-migration-preparation\\\n  -proof'),
    ).toContain(coordinatorPathStem);
    expect(
      normalizedManifestText('openspell-hosted-migration-runtime\\x2Dproof = "x"'),
    ).toContain(runtimeProofCargoName);
  });

  it("enables only the two non-default bridge features at their exact paths", () => {
    const coordinatorManifest = read(join(packageDirectory, "Cargo.toml"));
    const dependencyLines = tomlTable(coordinatorManifest, "dependencies")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const expected = [
      {
        cargoName: rootAuthorityCargoName,
        directory: join(workspaceDirectory, "tools/hosted-migration-root-authority"),
      },
      {
        cargoName: runtimeProofCargoName,
        directory: join(workspaceDirectory, "tools/hosted-migration-runtime-proof"),
      },
    ] as const;
    expect(dependencyLines).toHaveLength(expected.length);

    for (const dependency of expected) {
      const declaration = dependencyLines.find((line) =>
        line.startsWith(`${dependency.cargoName} = `),
      );
      expect(declaration).toBe(
        `${dependency.cargoName} = { path = "../${dependency.directory.split("/").at(-1)}", default-features = false, features = ["wp201-internal"] }`,
      );
      const relativePath = /path = "(?<path>[^"]+)"/u.exec(declaration ?? "")?.groups?.path;
      expect(relativePath).toBeDefined();
      expect(realpathSync(resolve(packageDirectory, relativePath ?? "missing"))).toBe(
        realpathSync(dependency.directory),
      );

      const bridgeManifest = read(join(dependency.directory, "Cargo.toml"));
      const features = tomlTable(bridgeManifest, "features")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(features).toContain("wp201-internal = []");
      expect(features.find((line) => line.startsWith("default =")) ?? "default = []").toBe(
        "default = []",
      );
      expect(features.find((line) => line.startsWith("default =")) ?? "").not.toContain(
        "wp201-internal",
      );
    }
  });

  it("allows no reverse consumer, application dependency, or second bridge enabler", () => {
    const manifests = workspaceManifests();
    const coordinatorManifestPath = join(packageDirectory, "Cargo.toml");
    const cargoConsumers = new Map([
      [rootAuthorityCargoName, [] as string[]],
      [runtimeProofCargoName, [] as string[]],
    ]);

    for (const manifest of manifests) {
      const contents = normalizedManifestText(read(manifest));
      if (manifest !== join(packageDirectory, "package.json")) {
        expect(contents, manifest).not.toContain(coordinatorNpmName);
      }
      if (manifest !== coordinatorManifestPath) {
        expect(contents, manifest).not.toContain(coordinatorCargoName);
      }
      if (![coordinatorManifestPath, join(packageDirectory, "package.json")].includes(manifest)) {
        expect(contents, manifest).not.toContain(coordinatorPathStem);
      }
      if (!manifest.endsWith("Cargo.toml")) continue;
      for (const cargoName of cargoConsumers.keys()) {
        const consumesByName = contents
          .split("\n")
          .some((line) => line.trimStart().startsWith(`${cargoName} =`));
        const consumesByAlias = contents.includes(`package = "${cargoName}"`);
        if (consumesByName || consumesByAlias) {
          cargoConsumers.get(cargoName)?.push(manifest);
        }
      }
    }

    expect(cargoConsumers).toEqual(
      new Map([
        [rootAuthorityCargoName, [coordinatorManifestPath]],
        [runtimeProofCargoName, [coordinatorManifestPath]],
      ]),
    );
  });

  it("contains no application, generic process, network, SQL, or deployment surface", () => {
    const library = read(join(packageDirectory, "src/lib.rs"));
    expect(library).not.toMatch(
      /\b(?:main|Command|Child|TcpStream|UdpSocket|UnixStream|Http|Request|Response|Sql|Query|Deploy|Service)\b/u,
    );
    const forbiddenEntries = new Set([
      "app",
      "apps",
      "bin",
      "build.rs",
      "deploy",
      "examples",
      "migrations",
      "service",
    ]);
    expect(readdirSync(packageDirectory).filter((entry) => forbiddenEntries.has(entry))).toEqual(
      [],
    );
    expect(readdirSync(join(packageDirectory, "src"))).not.toContain("main.rs");
  });
});
