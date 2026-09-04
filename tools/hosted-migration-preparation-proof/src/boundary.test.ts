import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
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

interface CargoTarget {
  readonly crate_types: readonly string[];
  readonly kind: readonly string[];
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

function read(relativePath: string): string {
  return readFileSync(join(packageDirectory, relativePath), "utf8");
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
    `${workspaceDirectory}:/workspace:ro`,
    "--workdir",
    "/workspace/tools/hosted-migration-preparation-proof",
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
    result = spawnSync("cargo", metadataArguments, { cwd: packageDirectory, encoding: "utf8" });
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

describe("private preparation-proof package boundary", () => {
  it("is exactly one inert private rlib with no default feature or executable surface", () => {
    expect(JSON.parse(read("package.json"))).toEqual({
      name: "@wizard-ads/hosted-migration-preparation-proof",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      devDependencies: { "@types/node": "^22.20.1" },
    });

    const metadata = cargoMetadata();
    expect(metadata.packages).toHaveLength(1);
    expect(metadata.workspace_members).toHaveLength(1);
    expect(metadata.packages[0]).toEqual(
      expect.objectContaining({
        name: "openspell-hosted-migration-preparation-proof",
        publish: [],
        features: {},
        targets: [
          expect.objectContaining({
            kind: ["rlib"],
            crate_types: ["rlib"],
            src_path: expect.stringMatching(/\/src\/lib\.rs$/u),
          }),
        ],
      }),
    );

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
    expect(cargo).not.toMatch(/^\s*\[features\]/mu);
    expect(cargo).not.toMatch(/^\s*\[\[(?:bin|example|bench|test)\]\]/mu);
    expect(cargo).not.toMatch(/^\s*\[(?:build-dependencies|dev-dependencies)\]/mu);

    expect(read("rust-toolchain.toml")).toBe(
      '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\n',
    );
    expect(
      readdirSync(packageDirectory)
        .filter((entry) => ![".turbo", "node_modules"].includes(entry))
        .sort(),
    ).toEqual([
      "Cargo.lock",
      "Cargo.toml",
      "package.json",
      "rust-toolchain.toml",
      "src",
      "tsconfig.json",
    ]);
    expect(readdirSync(sourceDirectory).sort()).toEqual([
      "boundary.test.ts",
      "composition.test.ts",
      "lib.rs",
    ]);
  });

  it("constructs the exact isolated read-only Docker metadata fallback", () => {
    expect(rustImage).toMatch(
      /^docker\.io\/library\/rust:1\.97\.1-bookworm@sha256:[0-9a-f]{64}$/u,
    );
    expect(rustImage.split("@sha256:")[1]).toHaveLength(64);
    const arguments_ = dockerMetadataArguments(123, 456);
    expect(arguments_.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(arguments_).toContain(`${workspaceDirectory}:/workspace:ro`);
    expect(arguments_).toContain("/workspace/tools/hosted-migration-preparation-proof");
    expect(arguments_.at(-6)).toBe("cargo");
    expect(arguments_.slice(-5)).toEqual([
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--locked",
    ]);
    expect(arguments_.at(-1)).toBe("--locked");
  });

  it("keeps the Rust implementation byte-small and incapable of effects", () => {
    const library = read("src/lib.rs");
    expect(library).toBe(
      "//! Inert composition boundary for the WP-201 preparation proof.\n\n#![forbid(unsafe_code)]\n",
    );
    expect(library).not.toMatch(
      /\b(?:pub|fn|struct|enum|trait|impl|mod|extern|use|std::process|std::net|sql|deploy|command)\b/iu,
    );
  });

  it("locks the local package to exactly its two bridge crates", () => {
    const lock = read("Cargo.lock");
    const block = lock.match(
      /\[\[package\]\]\nname = "openspell-hosted-migration-preparation-proof"\n[\s\S]*?(?=\n\[\[package\]\]|$)/u,
    );
    expect(block).not.toBeNull();
    expect(block?.[0]).toBe(
      '[[package]]\nname = "openspell-hosted-migration-preparation-proof"\nversion = "0.0.0"\ndependencies = [\n "openspell-hosted-migration-root-authority",\n "openspell-hosted-migration-runtime-proof",\n]\n',
    );

    expect(
      tomlTable(read("Cargo.toml"), "dependencies")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ).toEqual([
      'openspell-hosted-migration-root-authority = { path = "../hosted-migration-root-authority", default-features = false, features = ["wp201-internal"] }',
      'openspell-hosted-migration-runtime-proof = { path = "../hosted-migration-runtime-proof", default-features = false, features = ["wp201-internal"] }',
    ]);
  });
});
