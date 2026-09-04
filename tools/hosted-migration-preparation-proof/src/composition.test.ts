import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SOURCE_ROOTS,
  assertCompileTimeInputs,
  parseSourceIndex,
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
    const index = execFileSync(
      "/usr/bin/git",
      ["ls-files", "--stage", "-z", "--", ...SOURCE_ROOTS],
      { cwd: workspaceDirectory, maxBuffer: 1024 * 1024 },
    );
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
