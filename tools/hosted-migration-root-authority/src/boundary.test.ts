import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(packageDirectory, "src");
const workspaceDirectory = dirname(dirname(packageDirectory));
const rustImageFragments = Object.freeze([
  "docker.io/library/",
  "rust:1.97.1-bookworm",
  "@sha256:",
  "0e2bcaef56d041a4",
  "86784e54104a81ae",
  "be0da44bd03019bd",
  "70bc0401e42e4a97",
]);
const rustImage = rustImageFragments.join("");

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

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path) && readFileSync(path, "utf8").length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for Cargo target probe");
}

interface CargoTarget {
  readonly kind: readonly string[];
  readonly crate_types: readonly string[];
  readonly src_path: string;
}

interface CargoPackage {
  readonly features: Readonly<Record<string, readonly string[]>>;
  readonly name: string;
  readonly publish: readonly string[] | null;
  readonly targets: readonly CargoTarget[];
}

interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
  readonly workspace_members: readonly string[];
}

function exactLocalCargo(): boolean {
  const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  return (
    rustc.status === 0 &&
    rustc.stdout.startsWith("rustc 1.97.1 ") &&
    cargo.status === 0 &&
    cargo.stdout.startsWith("cargo 1.97.1 ")
  );
}

function dockerMetadataArguments(uid: number, gid: number): readonly string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    `${uid}:${gid}`,
    "--env",
    ["RUSTUP_", "TOOLCHAIN=", "1.97.1-", "x86_64-", "unknown-linux-gnu"].join(""),
    "--env",
    "CARGO_HOME=/cargo",
    "--env",
    "CARGO_TARGET_DIR=/target",
    "--env",
    "TMPDIR=/target",
    "--tmpfs",
    `/cargo:rw,uid=${uid},gid=${gid},mode=0700`,
    "--tmpfs",
    `/target:rw,exec,uid=${uid},gid=${gid},mode=0700`,
    "--volume",
    `${packageDirectory}:/workspace:ro`,
    "--workdir",
    "/workspace",
    rustImage,
    "cargo",
    "metadata",
    "--format-version",
    "1",
    "--no-deps",
    "--locked",
  ];
}

function cargoMetadata(): CargoMetadata {
  const metadataArguments = ["metadata", "--format-version", "1", "--no-deps", "--locked"];
  let result: SpawnSyncReturns<string>;
  if (exactLocalCargo()) {
    result = spawnSync("cargo", metadataArguments, {
      cwd: packageDirectory,
      encoding: "utf8",
    });
  } else {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("linux uid/gid required");
    result = spawnSync("docker", dockerMetadataArguments(uid, gid), {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  }
  if (result.error !== undefined) throw new Error("cargo metadata process failed");
  expect(result.status, "cargo metadata must succeed").toBe(0);
  return JSON.parse(result.stdout) as CargoMetadata;
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
      } else if (entry.isFile() && (entry.name === "package.json" || entry.name === "Cargo.toml")) {
        manifests.push(join(directory, entry.name));
      }
    }
  };
  visit(workspaceDirectory);
  return manifests;
}

describe("private root-authority package boundary", () => {
  it("has exactly one private rlib target in locked Cargo metadata", () => {
    const metadata = cargoMetadata();
    expect(metadata.packages).toHaveLength(1);
    expect(metadata.workspace_members).toHaveLength(1);
    const packageMetadata = metadata.packages[0];
    expect(packageMetadata?.name).toBe("openspell-hosted-migration-root-authority");
    expect(packageMetadata?.publish).toEqual([]);
    expect(packageMetadata?.features).toEqual({ "wp201-internal": [] });
    expect(packageMetadata?.targets).toEqual([
      expect.objectContaining({
        kind: ["rlib"],
        crate_types: ["rlib"],
        src_path: expect.stringMatching(/\/src\/lib\.rs$/u),
      }),
    ]);

    const cargo = read("Cargo.toml");
    expect(cargo).toContain("publish = false");
    expect(cargo).toContain("autobins = false");
    expect(cargo).toContain("autoexamples = false");
    expect(cargo).toContain("autobenches = false");
    expect(cargo).toContain('crate-type = ["rlib"]');
    expect(cargo).not.toMatch(/^\s*\[\[bin\]\]/mu);
    expect(cargo).not.toMatch(/^\s*\[\[example\]\]/mu);
    expect(cargo).not.toMatch(/^\s*\[\[bench\]\]/mu);

    const featureTable = /^\[features\]\n(?<body>(?:(?!^\[)[\s\S])*)/mu.exec(cargo)?.groups?.body;
    expect(featureTable?.trim()).toBe("wp201-internal = []");
    expect(read("src/lib.rs")).not.toContain("wp201_internal");

    const packageJson = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(packageJson.private).toBe(true);
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson).not.toHaveProperty("exports");
    expect(packageJson).not.toHaveProperty("main");
    expect(packageJson).not.toHaveProperty("dependencies");
  });

  it("constructs the exact isolated read-only Docker metadata fallback", () => {
    expect(rustImage).toMatch(
      /^docker\.io\/library\/rust:1\.97\.1-bookworm@sha256:[0-9a-f]{64}$/u,
    );
    expect(rustImage.split("@sha256:")[1]).toHaveLength(64);
    const wrapper = read("scripts/cargo.mjs");
    const declaration = /const image = \[(?<fragments>[\s\S]*?)\]\.join\(""\);/u.exec(wrapper);
    expect(declaration).not.toBeNull();
    const wrapperFragments = [
      ...(declaration?.groups?.fragments ?? "").matchAll(/^\s*"([^"]*)",$/gmu),
    ].map((match) => match[1]);
    expect(wrapperFragments).toEqual(rustImageFragments);

    const arguments_ = dockerMetadataArguments(123, 456);
    expect(arguments_.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(arguments_).toContain(`${packageDirectory}:/workspace:ro`);
    expect(
      arguments_.filter((_value, index) => arguments_[index - 1] === "--env"),
    ).toEqual([
      ["RUSTUP_", "TOOLCHAIN=", "1.97.1-", "x86_64-", "unknown-linux-gnu"].join(""),
      "CARGO_HOME=/cargo",
      "CARGO_TARGET_DIR=/target",
      "TMPDIR=/target",
    ]);
    expect(arguments_.slice(-7)).toEqual([
      rustImage,
      "cargo",
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--locked",
    ]);
    expect(arguments_.join("\n")).not.toMatch(/credential|password|secret|token/iu);
  });

  it("keeps rustdoc warnings fatal in the ordinary package check", () => {
    const wrapper = read("scripts/cargo.mjs");
    expect(wrapper).toContain(
      "cargo rustdoc --locked --lib --all-features -- -D warnings",
    );
    expect(wrapper).toContain("CARGO_TARGET_DIR: cargoTargetDirectory");
    expect(wrapper).toContain('Object.freeze(["/tmp", "/var/tmp"])');
    expect(wrapper).toContain("if (isWithin(workspaceDirectory, resolved)) continue");
    expect(wrapper).not.toContain("tmpdir()");
    expect(wrapper).toContain(
      "rmSync(cargoTargetDirectory, { force: true, recursive: true })",
    );
  });

  it("removes the isolated local Cargo target after a command failure", () => {
    const fixtureDirectory = mkdtempSync(
      join(tmpdir(), "openspell-root-authority-cargo-failure-"),
    );
    try {
      const binaryDirectory = join(fixtureDirectory, "bin");
      const cargoTempDirectory = join(fixtureDirectory, "tmp");
      mkdirSync(binaryDirectory);
      mkdirSync(cargoTempDirectory);
      const rustcPath = join(binaryDirectory, "rustc");
      const cargoPath = join(binaryDirectory, "cargo");
      writeFileSync(rustcPath, "#!/bin/sh\nprintf 'rustc 1.97.1 (fixture)\\n'\n", {
        mode: 0o700,
      });
      writeFileSync(
        cargoPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  printf 'cargo 1.97.1 (fixture)\\n'",
          "  exit 0",
          "fi",
          "exit 23",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(rustcPath, 0o700);
      chmodSync(cargoPath, 0o700);

      const result = spawnSync(process.execPath, [join(packageDirectory, "scripts/cargo.mjs"), "check"], {
        cwd: packageDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          TMPDIR: cargoTempDirectory,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(23);
      expect(readdirSync(cargoTempDirectory)).toEqual([]);
      expect(readdirSync(packageDirectory)).not.toContain("target");
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it("keeps populated abrupt-termination residue outside the workspace", async () => {
    const fixtureDirectory = mkdtempSync(
      join(tmpdir(), "openspell-root-authority-cargo-signal-"),
    );
    const probePath = join(fixtureDirectory, "target-path");
    let targetPath: string | undefined;
    let childProcess: ReturnType<typeof spawn> | undefined;
    try {
      const binaryDirectory = join(fixtureDirectory, "bin");
      mkdirSync(binaryDirectory);
      const rustcPath = join(binaryDirectory, "rustc");
      const cargoPath = join(binaryDirectory, "cargo");
      writeFileSync(rustcPath, "#!/bin/sh\nprintf 'rustc 1.97.1 (fixture)\\n'\n", {
        mode: 0o700,
      });
      writeFileSync(
        cargoPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  printf 'cargo 1.97.1 (fixture)\\n'",
          "  exit 0",
          "fi",
          'mkdir -p "$CARGO_TARGET_DIR/debug"',
          'printf artifact > "$CARGO_TARGET_DIR/debug/fingerprint"',
          'printf "%s" "$CARGO_TARGET_DIR" > "$CARGO_TARGET_PROBE"',
          "sleep 30",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      chmodSync(rustcPath, 0o700);
      chmodSync(cargoPath, 0o700);

      childProcess = spawn(
        process.execPath,
        [join(packageDirectory, "scripts/cargo.mjs"), "check"],
        {
          cwd: packageDirectory,
          detached: true,
          env: {
            ...process.env,
            CARGO_TARGET_PROBE: probePath,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
            TMPDIR: packageDirectory,
          },
          stdio: "ignore",
        },
      );
      const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          childProcess?.once("error", reject);
          childProcess?.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );

      await waitForFile(probePath);
      targetPath = readFileSync(probePath, "utf8");
      expect(basename(targetPath)).toMatch(/^openspell-root-authority-target-/u);
      expect(isWithin(workspaceDirectory, targetPath)).toBe(false);
      expect(existsSync(join(targetPath, "debug/fingerprint"))).toBe(true);

      if (childProcess.pid === undefined) throw new Error("Cargo wrapper pid unavailable");
      process.kill(-childProcess.pid, "SIGTERM");
      const outcome = await exit;
      childProcess = undefined;
      expect(outcome.code).toBeNull();
      expect(outcome.signal).toBe("SIGTERM");
      expect(existsSync(join(targetPath, "debug/fingerprint"))).toBe(true);
      expect(
        readdirSync(packageDirectory).filter((name) =>
          name.startsWith("openspell-root-authority-target-"),
        ),
      ).toEqual([]);
    } finally {
      if (childProcess?.pid !== undefined) {
        try {
          process.kill(-childProcess.pid, "SIGKILL");
        } catch {
          // The process group already exited.
        }
      }
      if (
        targetPath !== undefined &&
        basename(targetPath).startsWith("openspell-root-authority-target-") &&
        !isWithin(workspaceDirectory, targetPath)
      ) {
        rmSync(targetPath, { force: true, recursive: true });
      }
      rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it("forbids unsafe and exposes no public Rust API", () => {
    const sources = readdirSync(sourceDirectory, { recursive: true })
      .filter((name): name is string => typeof name === "string" && name.endsWith(".rs"))
      .map((name) => readFileSync(join(sourceDirectory, name), "utf8"));
    expect(read("src/lib.rs")).toContain("#![forbid(unsafe_code)]");
    for (const source of sources) {
      expect(source).not.toMatch(/\bunsafe\s*\{/u);
      expect(source).not.toMatch(/#\s*\[\s*macro_export\s*\]/u);
      expect(source).not.toMatch(/#\s*\[\s*(?:unsafe\s*\(\s*)?(?:no_mangle|export_name)/u);
      expect(source).not.toMatch(/\bextern\s+"C"\b/u);
      expect(source).not.toMatch(
        /^\s*pub\s+(?:async\s+)?(?:const|static|fn|struct|enum|union|trait|type|mod|use|extern\s+crate)\b/mu,
      );
    }
  });

  it("permits only the WP-201 coordinator to enable the reserved bridge feature", () => {
    const npmName = ["@wizard-ads/hosted-migration", "root-authority"].join("-");
    const cargoName = ["openspell-hosted-migration", "root-authority"].join("-");
    const packageStem = ["hosted-migration", "root-authority"].join("-");
    const coordinatorManifest = join(
      workspaceDirectory,
      "tools/hosted-migration-preparation-proof/Cargo.toml",
    );
    const manifests = workspaceManifests();
    const consumers: string[] = [];
    for (const manifest of manifests) {
      if (dirname(manifest) === packageDirectory) continue;
      const contents = normalizedManifestText(readFileSync(manifest, "utf8"));
      if (!contents.includes(packageStem)) continue;
      consumers.push(manifest);
      expect(manifest).toBe(coordinatorManifest);
      expect(contents).not.toContain(npmName);

      const dependencies = /^\[dependencies\]\n(?<body>(?:(?!^\[)[\s\S])*)/mu.exec(contents)?.groups
        ?.body;
      expect(dependencies, coordinatorManifest).toBeDefined();
      const escapedCargoName = cargoName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const dependencyPattern = new RegExp(
        `^${escapedCargoName}\\s*=\\s*\\{([^}\\n]*)\\}\\s*$`,
        "gmu",
      );
      const dependencyMatches = [...(dependencies ?? "").matchAll(dependencyPattern)];
      expect(dependencyMatches, coordinatorManifest).toHaveLength(1);
      const dependencyFields = dependencyMatches[0]?.[1] ?? "";
      expect(dependencyFields).toMatch(
        new RegExp(`(?:^|,)\\s*path\\s*=\\s*"\\.\\./${packageStem}"\\s*(?:,|$)`, "u"),
      );
      expect(dependencyFields).toMatch(/(?:^|,)\s*default-features\s*=\s*false\s*(?:,|$)/u);
      expect(dependencyFields).toMatch(
        /(?:^|,)\s*features\s*=\s*\[\s*"wp201-internal"\s*\]\s*(?:,|$)/u,
      );
      const unknownDependencyFields = dependencyFields
        .replace(
          new RegExp(`(?:^|,)\\s*path\\s*=\\s*"\\.\\./${packageStem}"\\s*(?=,|$)`, "u"),
          "",
        )
        .replace(/(?:^|,)\s*default-features\s*=\s*false\s*(?=,|$)/u, "")
        .replace(
          /(?:^|,)\s*features\s*=\s*\[\s*"wp201-internal"\s*\]\s*(?=,|$)/u,
          "",
        )
        .replace(/[\s,]/gu, "");
      expect(unknownDependencyFields, coordinatorManifest).toBe("");
      const dependencyLine = dependencyMatches[0]?.[0] ?? "";
      const remainingCoordinatorCargo = contents.replace(dependencyLine, "");
      expect(remainingCoordinatorCargo, coordinatorManifest).not.toContain(cargoName);
      expect(remainingCoordinatorCargo, coordinatorManifest).not.toContain(packageStem);
    }
    expect(consumers).toEqual(manifests.includes(coordinatorManifest) ? [coordinatorManifest] : []);
  });

  it("keeps deployment, process, network, database and credential capabilities absent", () => {
    const productionSources = readdirSync(sourceDirectory, { recursive: true })
      .filter(
        (name): name is string =>
          typeof name === "string" && name.endsWith(".rs") && name !== "tests.rs",
      )
      .map((name) => readFileSync(join(sourceDirectory, name), "utf8"));
    const productionManifestAndSources = [read("Cargo.toml"), ...productionSources].join("\n");
    for (const forbidden of [
      "reqwest",
      "tokio",
      "postgres",
      "supabase",
      "systemctl",
      "std::env",
      "TcpStream",
      "TcpListener",
      "UdpSocket",
      "rusqlite",
      "sqlx",
      "diesel",
      "libloading",
      "secret_service",
      "onepassword",
    ]) {
      expect(productionManifestAndSources).not.toContain(forbidden);
    }
    const processCapabilityPatterns = [
      /\b(?:std|tokio)\s*::\s*process\b/u,
      /\b(?:std|tokio)\s*::\s*\{[^}\n]*\bprocess\b/u,
      /\bprocess\s*::\s*(?:Command\b|\{[^}\n]*\bCommand\b)/u,
      /(?<![A-Za-z0-9_])Command\s*::\s*new\s*\(/u,
    ];
    expect(
      processCapabilityPatterns.some((pattern) => pattern.test(productionManifestAndSources)),
    ).toBe(false);
    expect(processCapabilityPatterns.some((pattern) => pattern.test("RegisterCommand::new("))).toBe(
      false,
    );
    for (const processUse of [
      "std::process::Command::new(",
      "use std::{process::Command}; Command::new(",
      "use std::{process as p}; p::Command::new(",
      "tokio::process::Command::new(",
    ]) {
      expect(processCapabilityPatterns.some((pattern) => pattern.test(processUse))).toBe(true);
    }
  });

  it("keeps production composition pathless, passive, non-destructive, and silent", () => {
    const productionSources = readdirSync(sourceDirectory, { recursive: true })
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          name.endsWith(".rs") &&
          name !== "tests.rs" &&
          !name.endsWith("_tests.rs"),
      )
      .map((name) => {
        const source = readFileSync(join(sourceDirectory, name), "utf8");
        if (name === "ipc.rs") return source.split("#[cfg(test)]\nmod tests")[0] ?? "";
        if (name === "crypto.rs") {
          return source.split("#[cfg(test)]\npub(crate) struct SyntheticRecordSigner")[0] ?? "";
        }
        return source;
      })
      .join("\n");

    for (const forbidden of [
      /\bstd\s*::\s*(?:env|fs|path|process)\b/u,
      /\b(?:Path|PathBuf|Command|SigningKey)\b/u,
      /\b(?:socket|socketpair|bind|listen|connect|accept)\s*\(/u,
      /\bFile\s*::/u,
      /\b(?:remove_file|remove_dir|rename|unlink|ftruncate|set_len)\s*\(/u,
      /\b(?:print|println|eprint|eprintln|dbg)!\s*\(/u,
      /\b(?:tracing|log)\s*::/u,
    ]) {
      expect(productionSources).not.toMatch(forbidden);
    }

    const signer = /pub\(crate\) trait RecordSigner \{(?<body>[\s\S]*?)\n\}/u.exec(
      read("src/crypto.rs"),
    )?.groups?.body;
    expect(signer).toBeDefined();
    expect(signer).not.toMatch(/\bfn\s+sign\s*\(/u);
    expect(signer?.match(/\bfn\s+sign_[a-z_]+\s*\(/gu)).toHaveLength(7);
  });

  it("rejects every forwarded test argument except the repository worker cap", () => {
    const result = spawnSync(process.execPath, [join(packageDirectory, "scripts/test.mjs"), "--x"], {
      cwd: packageDirectory,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("only the repository --maxWorkers=1 test argument is accepted");
  });
});
