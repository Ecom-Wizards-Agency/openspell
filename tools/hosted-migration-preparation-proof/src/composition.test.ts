import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
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
  assertCompileTimeInputs,
  assertNoFixedWorkspaceMountpoints,
  buildSourceLedgerRows,
  parseSourceIndex,
  stageFixedSourceSnapshot,
  verifySourceLedgerRows,
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

async function copiedCargoModule(index: Buffer): Promise<{
  readonly directory: string;
  readonly module: {
    readonly assertNoFixedWorkspaceMountpoints: typeof assertNoFixedWorkspaceMountpoints;
    readonly stageFixedSourceSnapshot: typeof stageFixedSourceSnapshot;
  };
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
  copyFileSync(join(packageDirectory, "scripts/cargo.mjs"), modulePath);
  const module = await import(
    `${pathToFileURL(modulePath).href}?fixture=${randomBytes(8).toString("hex")}`
  );
  return { directory, module };
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
      regularFileBytes: 1_281_104,
      records: 55,
    });
    expect(Buffer.byteLength(sourceLedger.ledgerRows, "utf8")).toBe(6_533);
    expect(createHash("sha256").update(sourceLedger.ledgerRows).digest("hex")).toBe(
      "6a224a221f053899905985486de42b986e551f014c0e758a8efb6f50256c2289",
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
        regularFileBytes: 1_281_104,
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
        regularFileBytes: 1_281_104,
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
