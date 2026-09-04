import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(packageDirectory, "src");

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
    expect(readdirSync(sourceDirectory).sort()).toEqual([
      "boundary.test.ts",
      "composition.test.ts",
      "interruption.test.ts",
      "lib.rs",
    ]);

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
      "scripts",
      "src",
      "tsconfig.json",
    ]);
    expect(readdirSync(sourceDirectory).sort()).toEqual([
      "boundary.test.ts",
      "composition.test.ts",
      "interruption.test.ts",
      "lib.rs",
    ]);
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
