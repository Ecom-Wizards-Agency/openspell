import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(packageDirectory, "src");
const workspaceDirectory = dirname(dirname(packageDirectory));

const expectedRustSources = Object.freeze([
  "archive.rs",
  "canonical.rs",
  "elf.rs",
  "lib.rs",
  "linux_abi.rs",
  "linux_kernel_tests.rs",
  "machine.rs",
  "model_tests.rs",
  "policy.rs",
  "provenance.rs",
  "provenance_tests.rs",
  "ticket.rs",
]);
const testOnlyRustSources = new Set([
  "linux_abi.rs",
  "linux_kernel_tests.rs",
  "model_tests.rs",
  "provenance_tests.rs",
]);
const libraryModules = Object.freeze([
  "archive",
  "canonical",
  "elf",
  "machine",
  "policy",
  "provenance",
  "ticket",
  "model_tests",
  "provenance_tests",
]);
const libraryTestModules = Object.freeze(["model_tests.rs", "provenance_tests.rs"]);
const wp201CoordinatorDirectory = join(
  workspaceDirectory,
  "tools/hosted-migration-preparation-proof",
);
const wp201CoordinatorCargoManifest = join(wp201CoordinatorDirectory, "Cargo.toml");

function read(relativePath: string): string {
  return readFileSync(join(packageDirectory, relativePath), "utf8");
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

function runtimeImageFromWrapper(): string {
  const wrapper = read("scripts/cargo.mjs");
  const imageDeclaration = /export const image = \[([\s\S]*?)\]\.join\(""\);/u.exec(wrapper);
  if (imageDeclaration?.[1] === undefined) throw new Error("exact runtime image declaration required");
  const fragments = [...imageDeclaration[1].matchAll(/^\s*("[^"]*"),?\s*$/gmu)].map(
    (match) => JSON.parse(match[1] ?? "null") as unknown,
  );
  if (fragments.length === 0 || fragments.some((fragment) => typeof fragment !== "string")) {
    throw new Error("exact runtime image fragments required");
  }
  return fragments.join("");
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

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

describe("private hosted-migration runtime proof boundary", () => {
  it("pins its immutable ticket corpus to the authoritative WP-199 corpus", () => {
    const local = readFileSync(join(packageDirectory, "fixtures/wp199-grant-ticket-v1.golden.json"));
    const authoritative = readFileSync(
      join(
        workspaceDirectory,
        "tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json",
      ),
    );
    expect(local).toEqual(authoritative);
  });

  it("pins a private library-only package with explicit test entrypoints", () => {
    const packageJson = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(packageJson).toEqual({
      name: "@wizard-ads/hosted-migration-runtime-proof",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        typecheck: "node scripts/cargo.mjs check && tsc --noEmit",
        test: "node scripts/test.mjs",
        "test:kernel": "node scripts/kernel-proof.mjs",
        "test:kernel-interruptions": "node scripts/kernel-proof-interruption.mjs",
      },
      devDependencies: { "@types/node": "^22.20.1" },
    });

    const cargo = read("Cargo.toml");
    for (const declaration of [
      "publish = false",
      "autobins = false",
      "autoexamples = false",
      "autobenches = false",
      'crate-type = ["rlib"]',
    ]) {
      expect(cargo).toContain(declaration);
    }
    expect(cargo).not.toMatch(/^\s*\[\[(?:bin|example|bench)\]\]/gmu);
    const libStart = cargo.indexOf("[lib]");
    const nextTable = cargo.indexOf("\n[", libStart + "[lib]".length);
    const libTable = cargo.slice(libStart, nextTable === -1 ? undefined : nextTable);
    expect(libTable).not.toMatch(/^\s*name\s*=/mu);
    expect(
      tomlTable(cargo, "features")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ).toEqual(["default = []", "kernel-proof = []", "wp201-internal = []"]);
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson).not.toHaveProperty("exports");
    expect(packageJson).not.toHaveProperty("main");
    expect(packageJson).not.toHaveProperty("dependencies");
  });

  it("pins the complete Rust module inventory and test-only kernel boundary", () => {
    const actual = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".rs"))
      .sort();
    expect(actual).toEqual([...expectedRustSources].sort());

    const library = read("src/lib.rs");
    expect(library).toContain("#![deny(unsafe_code)]");
    expect(
      [
        ...library.matchAll(
          /^(?:pub(?:\([^\n)]*\))?\s+)?mod\s+([a-z0-9_]+);$/gmu,
        ),
      ].map((match) => match[1]),
    ).toEqual(libraryModules);
    expect(library).not.toMatch(/\bmod\s+wp201_internal\b/u);
    for (const file of libraryTestModules) {
      expect(library).toMatch(
        new RegExp(`#\\[cfg\\(test\\)\\]\\s*mod ${file.replace(/\.rs$/u, "")};`, "u"),
      );
    }
    expect(library).not.toContain("mod linux_abi;");
    expect(library).not.toContain("mod linux_kernel_tests;");
    expect(read("Cargo.toml")).toMatch(
      /\[\[test\]\]\s*name = "linux-kernel-proof"\s*path = "src\/linux_kernel_tests\.rs"\s*harness = false\s*required-features = \["kernel-proof"\]/u,
    );
    for (const file of expectedRustSources) {
      const source = read(`src/${file}`);
      expect(source, file).not.toMatch(/#\s*\[\s*macro_export\s*\]/u);
      expect(source, file).not.toMatch(
        /#\s*\[\s*(?:unsafe\s*\(\s*)?(?:no_mangle|export_name)/u,
      );
      expect(source, file).not.toMatch(
        /^\s*pub\s+(?:async\s+)?(?:const|static|fn|struct|enum|union|trait|type|mod|use|extern\s+crate)\b/mu,
      );
      if (file !== "linux_abi.rs") {
        expect(source, file).not.toMatch(/\bextern\s+"C"\b/u);
        expect(source, file).not.toMatch(/\bunsafe\s*\{/u);
      }
    }
  });

  it("keeps production free of process, network, database, secret and deployment capability", () => {
    const production = expectedRustSources
      .filter((file) => !testOnlyRustSources.has(file))
      .map((file) => read(`src/${file}`))
      .join("\n");
    for (const forbidden of [
      /\bstd\s*::\s*process\b/u,
      /\bprocess\s*::\s*Command\b/u,
      /(?<![A-Za-z0-9_])Command\s*::\s*new\s*\(/u,
      /\b(?:TcpStream|TcpListener|UdpSocket|UnixStream|UnixListener)\b/u,
      /\b(?:socket|socketpair|bind|listen|connect|accept)\s*\(/u,
      /\b(?:reqwest|hyper|tokio|postgres|rusqlite|sqlx|diesel)\b/u,
      /\b(?:clone3|ptrace|pidfd_open|unshare|setns)\s*\(/u,
      /\b(?:std|core)\s*::\s*env\b/u,
      /\b(?:getenv|setenv|unsetenv)\s*\(/u,
      /\b(?:systemctl|supabase::|onepassword|credential|secret_service)\b/iu,
      /\b(?:print|println|eprint|eprintln|dbg)!\s*\(/u,
    ]) {
      expect(production).not.toMatch(forbidden);
    }

    const cargoProduction = read("Cargo.toml").split("[dev-dependencies]")[0] ?? "";
    expect(cargoProduction).toContain(
      'rustix = { version = "=1.1.4", default-features = false, features = ["fs", "std"] }',
    );
    for (const dependency of ["libc", "nix", "reqwest", "tokio", "sqlx", "postgres"])
      expect(cargoProduction).not.toMatch(new RegExp(`^${dependency}\\s*=`, "mu"));
  });

  it("permits only the exact WP-201 coordinator reverse dependency and no workspace-local output", () => {
    const npmName = "@wizard-ads/hosted-migration-runtime-proof";
    const cargoName = "openspell-hosted-migration-runtime-proof";
    const cargoPathName = "hosted-migration-runtime-proof";
    for (const manifest of workspaceManifests()) {
      if (dirname(manifest) === packageDirectory) continue;
      const contents = normalizedManifestText(readFileSync(manifest, "utf8"));
      expect(contents, manifest).not.toContain(npmName);
      if (manifest === wp201CoordinatorCargoManifest) continue;
      expect(contents, manifest).not.toContain(cargoName);
      expect(contents, manifest).not.toContain(cargoPathName);
    }

    if (existsSync(wp201CoordinatorCargoManifest)) {
      const coordinatorCargo = normalizedManifestText(
        readFileSync(wp201CoordinatorCargoManifest, "utf8"),
      );
      expect(tomlTable(coordinatorCargo, "package")).toMatch(
        /^\s*name\s*=\s*"openspell-hosted-migration-preparation-proof"\s*$/mu,
      );
      const coordinatorDependencies = tomlTable(coordinatorCargo, "dependencies");
      const escapedCargoName = cargoName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const dependencyPattern = new RegExp(
        `^${escapedCargoName}\\s*=\\s*\\{([^}\\n]*)\\}\\s*$`,
        "gmu",
      );
      const dependencyMatches = [...coordinatorDependencies.matchAll(dependencyPattern)];
      expect(dependencyMatches, wp201CoordinatorCargoManifest).toHaveLength(1);
      const dependencyFields = dependencyMatches[0]?.[1] ?? "";
      expect(dependencyFields).toMatch(
        /(?:^|,)\s*path\s*=\s*"\.\.\/hosted-migration-runtime-proof"\s*(?:,|$)/u,
      );
      expect(dependencyFields).toMatch(/(?:^|,)\s*default-features\s*=\s*false\s*(?:,|$)/u);
      expect(dependencyFields).toMatch(
        /(?:^|,)\s*features\s*=\s*\[\s*"wp201-internal"\s*\]\s*(?:,|$)/u,
      );
      const unknownDependencyFields = dependencyFields
        .replace(/(?:^|,)\s*path\s*=\s*"\.\.\/hosted-migration-runtime-proof"\s*(?=,|$)/u, "")
        .replace(/(?:^|,)\s*default-features\s*=\s*false\s*(?=,|$)/u, "")
        .replace(
          /(?:^|,)\s*features\s*=\s*\[\s*"wp201-internal"\s*\]\s*(?=,|$)/u,
          "",
        )
        .replace(/[\s,]/gu, "");
      expect(unknownDependencyFields, wp201CoordinatorCargoManifest).toBe("");
      const dependencyLine = dependencyMatches[0]?.[0] ?? "";
      const remainingCoordinatorCargo = coordinatorCargo.replace(dependencyLine, "");
      expect(remainingCoordinatorCargo, wp201CoordinatorCargoManifest).not.toContain(cargoName);
      expect(remainingCoordinatorCargo, wp201CoordinatorCargoManifest).not.toContain(cargoPathName);
    }

    const wrapper = read("scripts/cargo.mjs");
    expect(wrapper).toContain('Object.freeze(["/tmp", "/var/tmp"])');
    expect(wrapper).toContain("if (isWithin(workspaceDirectory, resolved)) continue");
    expect(wrapper).toContain("cargo rustdoc --locked --lib --all-features -- -D warnings");
    expect(isWithin(workspaceDirectory, join(packageDirectory, "target"))).toBe(true);
  });

  it("keeps ordinary tests unprivileged and rejects arbitrary forwarded arguments", () => {
    const ordinary = read("scripts/test.mjs");
    for (const forbidden of ["--privileged", "--cap-add", "--cgroupns", "docker run"])
      expect(ordinary).not.toContain(forbidden);
    expect(ordinary).toContain('forwarded[0] !== "--maxWorkers=1"');
    expect(read("scripts/cargo.mjs")).toContain(
      'test: "cargo test --locked --lib --all-features"',
    );

    const kernel = read("scripts/kernel-proof.mjs");
    expect(kernel).toContain('"--network"');
    expect(kernel).toContain('"none"');
    expect(kernel).toContain('"--read-only"');
    expect(kernel).toContain('"--cgroupns"');
    expect(kernel).toContain('"private"');
    expect(kernel).toContain(
      '"CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-C target-feature=+crt-static"',
    );
    expect(kernel).toContain("verifyStaticExecutable");
    expect(kernel).toContain("bytes.readUInt16LE(16) !== 3");
    expect(kernel).toContain('"type=volume,destination=/target,volume-nocopy"');
    expect(kernel).toContain("extractSingleFileArchive");
    expect(kernel).toContain('["container", "cp", `${containerId}:${insideTarget}`, "-"]');
    expect(kernel).toContain('process.on("SIGINT", recordInterruption)');
    expect(kernel).toContain('process.on("SIGTERM", recordInterruption)');
    expect(kernel).toContain("await interruptionCheckpoint()");
    expect(kernel).toContain("async function buildArtifact(baseImageId)");
    expect(kernel).toContain("async function stageProofImage(artifact, base)");
    expect(kernel).toContain("async function runCase(imageId, mode, expected)");
    expect(kernel).toContain("await runCase(imageId, mode, expected)");
    expect(kernel).toContain("detached: true");
    expect(kernel).toContain("captureAnonymousTargetVolume");
    expect(kernel).not.toContain('["volume", "rm", volume]');
    expect(kernel).toContain("if (unresolvedCreation) throw new Error");
    expect(kernel.indexOf("proveImageAbsent(derivedImageId, recoveryImageTag)")).toBeLessThan(
      kernel.lastIndexOf("process.stdout.write(successSummary)"),
    );
    expect(kernel).not.toContain("= inspectContainer(name)");
    expect(kernel).not.toContain("inspectImage(recoveryImageTag)");
    expect(kernel).toContain("stageProofImage");
    expect(kernel).toContain('"container", "cp"');
    expect(kernel).toContain('"container", "commit"');
    expect(kernel).toContain("verifyImageLineage");
    expect(kernel).toContain('["image", "rm", "--no-prune", id]');
    expect(kernel).not.toContain('"image", "rm", "--force"');
    const interruptionProof = read("scripts/kernel-proof-interruption.mjs");
    expect(interruptionProof).toContain(
      'await proveSignal("SIGINT", "openspell-wp200-build-", "build-create")',
    );
    expect(interruptionProof).toContain(
      '"openspell-wp200-stage-", "image-commit", true',
    );
    expect(interruptionProof).toContain(
      'await proveSignal("SIGINT", "openspell-wp200-case-", "case-inspect")',
    );
    expect(interruptionProof).toContain(
      'await proveSignal("SIGTERM", "openspell-wp200-case-", "case-running")',
    );
    expect(interruptionProof).toContain("await proveFinalCleanupSignal()");
    expect(interruptionProof).toContain('process.kill(-child.pid, signal)');
    expect(interruptionProof).toContain("await awaitResponseHeld(responseCut, child)");
    expect(interruptionProof).toContain("readResponseIdentity(responseCut)");
    expect(interruptionProof).toContain("responseIdentity.containerId");
    expect(interruptionProof).toContain("responseIdentity.imageId");
    expect(interruptionProof).toContain('prepareResponseCut("final-image-delete")');
    expect(interruptionProof).not.toContain('listExact(`name=^/${prefix}`');
    expect(interruptionProof).toContain('phase() !== "signal-observed\\n"');
    expect(interruptionProof).toContain(
      'phase() !== "cases-complete\\nsignal-observed\\n"',
    );
    expect(interruptionProof).toContain("function runOwnedDocker(");
    expect(interruptionProof).toContain("async function provePostRecoveryAbsent(custody)");
    expect(interruptionProof).toContain("async function proveOwnedCommandDeadline()");
    expect(interruptionProof).toContain("async function proveUninspectedResponseRecovery()");
    expect(interruptionProof).toContain("ownedClientStopReserveMilliseconds = 1_250");
    expect(interruptionProof).toContain('signalProcessGroup(child, "SIGKILL")');
    expect(interruptionProof).toContain('["volume", "ls", "--quiet"]');
    const responseShim = read("scripts/docker-response-shim.mjs");
    expect(responseShim).toContain('cut === "build-create"');
    expect(responseShim).toContain('cut === "image-commit"');
    expect(responseShim).toContain('cut === "case-inspect"');
    expect(responseShim).toContain('cut === "case-running"');
    expect(responseShim).toContain('cut === "final-image-delete"');
    expect(responseShim).toContain('process.env["WP200_DOCKER_RESPONSE_IDENTITY"]');
    expect(responseShim).toContain("publishSelectedResponse(heldStdout)");
    expect(responseShim).toContain("writeFileSync(identityFile");
    expect(responseShim).toContain('"external-interruption-hold"');
    expect(responseShim).toContain(
      'spawn(realDocker, ["container", "kill", containerId]',
    );
    expect(responseShim).toContain("refusePostCutCaseStart()");
    expect(responseShim).toContain('writeFileSync(startAttemptFile, "attempted\\n"');
    expect(responseShim).toContain("primaryHoldTimeoutMilliseconds = 15 * 60_000");
    expect(responseShim).toContain("finalDeleteHoldTimeoutMilliseconds = 65 * 60_000");
    expect(responseShim).toContain("const deadline = performance.now() + timeoutMilliseconds");
    expect(responseShim).toContain("while (performance.now() < deadline)");
    expect(responseShim).toContain('process.on("SIGTERM", keepHeld)');
    expect(responseShim).toContain('process.off("SIGTERM", keepHeld)');
    expect(responseShim).toContain("writeFileSync(readyFile");
    expect(interruptionProof).toContain(
      "forbiddenStartObserved = existsSync(responseCut.startAttempt)",
    );
    expect(interruptionProof).toContain("forbiddenStartObserved ||");
    expect(interruptionProof).toContain('child.once("close", closed)');
    expect(interruptionProof).not.toContain('child.once("exit"');
    expect(interruptionProof).toContain("observedExit = observeChildExit(child)");
    expect(interruptionProof).toContain("waitForObservedExit(observedExit)");
    expect(interruptionProof).toContain(
      "setupObservationTimeoutMilliseconds = 10 * 60_000",
    );
    expect(interruptionProof).toContain("performance.now() < deadline");
    expect(interruptionProof).toContain("remainingOperationTime(deadline)");
    expect(interruptionProof).toContain(
      "finalCleanupObservationTimeoutMilliseconds = 60 * 60_000",
    );
    expect(interruptionProof).toContain("primaryTimedOut ||");
    expect(interruptionProof).toContain("forcedExitUsed ||");
    expect(interruptionProof).toContain("await recoverCapturedObjects(custody)");
    expect(interruptionProof).toContain("async function settleChildCustody(");
    expect(interruptionProof).toContain("const stopped = await settleChildCustody(");
    expect(interruptionProof).toContain("requireWatchdogFixtureImage(imageAcquisition)");
    expect(interruptionProof).not.toContain("function proveCapturedObjectsAbsent(custody)");
    expect(interruptionProof).toContain(
      "await proveCapturedObjectsAbsentBounded(custody, deadline)",
    );
    expect(interruptionProof).not.toContain('["volume", "rm"');
    expect(interruptionProof).toContain("await stopEventWatcher(watcher, watcherExit)");
    expect(interruptionProof).toContain("watcherTerminal.timedOut ||");
    expect(interruptionProof).toContain("await proveWatchdogRecovery()");
    expect(
      interruptionProof.indexOf(
        'containerId = typeof created.stdout === "string" ? created.stdout.trim()',
      ),
    ).toBeLessThan(
      interruptionProof.indexOf("requireDocker(created)"),
    );
    expect(interruptionProof).toContain("const volumesBefore = await volumeInventory()");
    expect(interruptionProof).toContain(
      "JSON.stringify(volumes.sort()) !== JSON.stringify(custody.volumesBefore)",
    );
    expect(interruptionProof).toContain(
      "interruption-cuts=5 watchdog-recovery=1 uninspected-recovery=1 owned-client-deadline=1 owned-output-overflow=1 signals=2 residue=0",
    );
    expect(interruptionProof).toContain("async function awaitExactPhase(");
    expect(interruptionProof).toContain("finalCleanupObservationTimeoutMilliseconds,");
    expect(interruptionProof).toContain("awaitFinalDeleteHeld(responseCut, child)");
    expect(interruptionProof).toContain("releaseFinalDeleteResponse(responseCut)");
    expect(responseShim).toContain("selectedFinalDeleteImageId()");
    expect(responseShim).toContain('args[0] !== "image"');
    expect(responseShim).toContain('args[1] !== "rm"');
    expect(responseShim).toContain('args[2] !== "--no-prune"');
    expect(responseShim).toContain("args[3] === identity.imageId");
    expect(responseShim).toContain("await publishFinalDeleteResponse()");
    expect(interruptionProof).toContain("async function proveOwnedOutputOverflow()");
    expect(interruptionProof).toContain("stdout.overflowed() ||");
    expect(interruptionProof).toContain("stderr.overflowed() ||");
    expect(interruptionProof).toContain("const outcome = new Promise((resolve) =>");
    expect(interruptionProof).not.toContain("const deleted = new Promise((resolve, reject)");
    expect(interruptionProof).toContain("const deletionFailure = deletion.outcome.then(");
    expect(interruptionProof).toContain("const wrapperExit = observedExit.then(");
    const finalCut = interruptionProof.slice(
      interruptionProof.indexOf("async function proveFinalCleanupSignal()"),
    );
    expect(
      finalCut.indexOf("awaitExactPhase("),
    ).toBeLessThan(finalCut.indexOf("awaitFinalDeleteHeld(responseCut, child)"));
    expect(
      finalCut.indexOf("awaitFinalDeleteHeld(responseCut, child)"),
    ).toBeLessThan(finalCut.indexOf("const deletionOutcome = await Promise.race("));
    expect(finalCut.indexOf("const deletionOutcome = await Promise.race(")).toBeLessThan(
      finalCut.indexOf('signalProcessGroup(child, "SIGINT")'),
    );
    expect(kernel).toContain('"/usr/bin/setpriv"');
    expect(kernel).toContain('"--bounding-set=-all,+sys_admin,+setfcap"');
    expect(kernel).toContain('"--no-new-privs"');
    expect(kernel).toContain('process.env["WP200_KERNEL_PROOF_PHASE_FD"] === "3"');
    expect(kernel).toContain('publishTestPhase("cases-complete")');
    expect(kernel).toContain('publishTestPhase("signal-observed")');
    for (const mode of [
      "success",
      "refusal",
      "timeout",
      "interruption",
      "unexpected-event",
      "fault-intent",
      "fault-namespace",
      "fault-cgroup",
      "fault-spawn",
      "fault-leader-attest",
      "fault-bootstrap",
      "lost-resume-one",
      "lost-resume-two",
      "lost-drain",
      "lost-empty-cgroup",
      "lost-terminal-proof",
      "tracer-death-stopped",
      "tracer-death-mixed",
      "tracer-death-resumed",
    ])
      expect(kernel).toContain(`"${mode}"`);
    const proofContainer = kernel
      .split("function runCase", 2)[1]
      ?.split("function removeTargetDirectory", 1)[0];
    expect(proofContainer).toBeDefined();
    expect(proofContainer).not.toMatch(
      /(?:packageDirectory|CARGO_HOME|\/workspace|\/cargo|\/target|credential|browser|docker\.sock|systemd|service)/iu,
    );
    expect(proofContainer).not.toContain('"--mount"');
    expect(proofContainer).toContain("imageId");
    const removeBuildAt = kernel.indexOf("targetVolume === undefined ? [] : [targetVolume]");
    const runCasesAt = kernel.indexOf("for (const [mode, expected] of cases)");
    expect(removeBuildAt).toBeGreaterThan(0);
    expect(runCasesAt).toBeGreaterThan(removeBuildAt);
    expect(kernel.match(/verifyImageArtifact\(imageId, artifact\.digest\)/gu)).toHaveLength(2);
    expect(proofContainer).not.toContain("result.stderr.trim()");
    expect(kernel).not.toContain("error.stack");
    expect(kernel).not.toContain("${result.stderr}");
    expect(kernel).not.toContain("${result.status}");
    expect(kernel).not.toContain("${result.signal}");

    const realProof = read("src/linux_kernel_tests.rs");
    expect(realProof).toContain("EffectKind::AttestLeaderExecAndMaps");
    expect(realProof).toContain("EffectKind::BootstrapVerifiedProcesses");
    expect(realProof).toContain("bootstrap_continue(machine, &bootstrap, resources");
    expect(realProof).toContain("bootstrap_preexec_continue(machine, &bootstrap, resources)");
    expect(realProof).toContain("machine.authorizes_bootstrap_continue(effect)");
    expect(realProof).toContain("machine.authorizes_resume_continue(effect)");
    expect(realProof).toContain("verify_prebootstrap_authority");
    expect(realProof).toContain("elf.header.e_type != ET_DYN");
    expect(realProof).toContain("TracerDeathCut::MixedResume");
    expect(realProof).toContain("TracerDeathCut::FullResume");
    expect(realProof).toContain('mode == "external-interruption-hold"');
    expect(realProof).toContain("hold_for_external_interruption");
    expect(realProof).toContain("expect_eof_bounded");
    const childBeforeExec = realProof
      .split("fn child_before_exec", 2)[1]
      ?.split("fn run_front_controller", 1)[0];
    expect(childBeforeExec).toBeDefined();
    expect(childBeforeExec?.indexOf("stop_self()")).toBeLessThan(
      childBeforeExec?.indexOf("drop_authority_before_exec()") ?? -1,
    );
  });

  it("keeps the privileged proof off pull requests and out of credentialed CI", () => {
    const ordinary = readFileSync(join(workspaceDirectory, ".github/workflows/ci.yml"), "utf8");
    expect(ordinary).not.toContain("test:kernel");

    const trusted = readFileSync(
      join(workspaceDirectory, ".github/workflows/trusted-kernel-proof.yml"),
      "utf8",
    );
    expect(trusted).toContain("workflow_run:");
    expect(trusted).toContain('workflows: ["CI"]');
    expect(trusted).toContain('branches: ["main"]');
    expect(trusted).not.toContain("workflow_dispatch");
    expect(trusted).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(trusted).toContain("github.event.workflow_run.event == 'push'");
    expect(trusted).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(trusted).toContain("TRUSTED_SHA: ${{ github.event.workflow_run.head_sha }}");
    expect(trusted).toContain("permissions: {}");
    expect(trusted).not.toContain("actions/checkout");
    const actionPins = trusted
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- uses: "))
      .map((line) => line.slice("- uses: ".length));
    expect(actionPins).toEqual([
      ["pnpm/action-setup@", "b906affcce14559a", "d1aafd4ab0e94277", "9e9f58b1"].join(""),
      ["actions/setup-node@", "49933ea5288caeca", "8642d1e84afbd3f7", "d6820020"].join(""),
    ]);
    expect(actionPins.every((entry) => /@[0-9a-f]{40}$/u.test(entry))).toBe(true);
    expect(trusted).toContain("Fetch exact trusted revision without a credential");
    expect(trusted).toContain('git -C workspace fetch --depth=1 origin "$TRUSTED_SHA"');
    expect(trusted).toContain('test "$(git -C workspace rev-parse HEAD)" = "$TRUSTED_SHA"');
    expect(trusted).toContain("package_json_file: workspace/package.json");
    expect(trusted).toContain("Acquire exact proof-builder image");
    const pullPrefix = "run: docker image pull ";
    const pullLines = trusted
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(pullPrefix));
    expect(pullLines).toHaveLength(1);
    expect(pullLines[0]?.slice(pullPrefix.length)).toBe(runtimeImageFromWrapper());
    const acquisitionAt = trusted.indexOf("Acquire exact proof-builder image");
    const proofAt = trusted.indexOf("Verify hosted migration Linux runtime proof");
    expect(acquisitionAt).toBeGreaterThan(0);
    expect(acquisitionAt).toBeLessThan(proofAt);
    const timeoutMinutes = [...trusted.matchAll(/timeout-minutes: (\d+)/gu)].map((match) =>
      Number(match[1]),
    );
    expect(timeoutMinutes).toEqual([230, 5, 5, 10, 10, 5, 180]);
    const [jobMinutes, ...stepMinutes] = timeoutMinutes;
    const pullMinutes = stepMinutes.at(-2);
    const proofMinutes = stepMinutes.at(-1);
    expect(pullMinutes).toBe(5);
    expect(proofMinutes).toBeGreaterThanOrEqual(90);
    expect(jobMinutes).toBeGreaterThanOrEqual(
      stepMinutes.reduce((sum, minutes) => sum + minutes, 0) + 15,
    );
    expect(trusted).not.toContain("continue-on-error");
    expect(trusted).not.toContain("|| true");
    const kernelWrapper = read("scripts/kernel-proof.mjs");
    expect(kernelWrapper).toContain(
      'spawnSync("docker", ["container", "create", "--pull", "never", ...args]',
    );
    expect(kernelWrapper).toContain("const base = inspectImage(image)");
    expect(kernelWrapper).toContain("buildArtifact(base.Id)");
    const interruptionWrapper = read("scripts/kernel-proof-interruption.mjs");
    expect(
      interruptionWrapper.match(
        /"container",\s*"create",\s*"--pull",\s*"never"/gu,
      ),
    ).toHaveLength(2);
    expect(interruptionWrapper).toContain("async function resolveBaseImageId(deadline)");
    expect(interruptionWrapper).toContain(
      'await runOwnedDocker(["image", "inspect", image], deadline)',
    );
    expect(interruptionWrapper).toContain("let realDocker;");
    expect(interruptionWrapper).toContain("realDocker = resolveDocker();");
    expect(interruptionWrapper).toContain("let baseImageId;");
    expect(interruptionWrapper).toContain("baseImageId = await resolveBaseImageId(");
    expect(trusted).toContain(
      "pnpm --filter @wizard-ads/hosted-migration-runtime-proof run test:kernel",
    );
  });

  it("resolves known official runtime objects only beneath a supplied descriptor", () => {
    const elf = read("src/elf.rs");
    expect(elf).toMatch(
      /fn inspect_official_components\(\s*release: &RetainedRelease<OfficialEvidence>,\s*runtime_root: &File,/u,
    );
    for (const fixedPath of [
      "usr/local/libexec/supabase",
      "usr/local/libexec/supabase-go",
      "lib64/ld-linux-x86-64.so.2",
      "usr/lib/x86_64-linux-gnu/libc.so.6",
      "usr/lib/x86_64-linux-gnu/libdl.so.2",
      "usr/lib/x86_64-linux-gnu/libm.so.6",
      "usr/lib/x86_64-linux-gnu/libpthread.so.0",
    ]) {
      expect(elf).toContain(fixedPath);
    }
    for (const resolution of ["BENEATH", "NO_SYMLINKS", "NO_MAGICLINKS", "NO_XDEV"])
      expect(elf).toContain(`ResolveFlags::${resolution}`);
    expect(elf).toContain("IncompleteOfficialRuntime");
  });
});
