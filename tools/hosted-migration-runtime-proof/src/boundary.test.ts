import { readFileSync, readdirSync } from "node:fs";
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
const libraryTestModules = Object.freeze(["model_tests.rs", "provenance_tests.rs"]);

function read(relativePath: string): string {
  return readFileSync(join(packageDirectory, relativePath), "utf8");
}

function workspaceManifests(): readonly string[] {
  const manifests: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
    for (const dependency of ["libc", "nix", "reqwest", "tokio", "sqlx", "postgres"])
      expect(cargoProduction).not.toMatch(new RegExp(`^${dependency}\\s*=`, "mu"));
  });

  it("has no reverse dependency or workspace-local output", () => {
    const npmName = "@wizard-ads/hosted-migration-runtime-proof";
    const cargoName = "openspell-hosted-migration-runtime-proof";
    for (const manifest of workspaceManifests()) {
      if (dirname(manifest) === packageDirectory) continue;
      const contents = readFileSync(manifest, "utf8");
      expect(contents, manifest).not.toContain(npmName);
      expect(contents, manifest).not.toContain(cargoName);
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
    const proofContainer = kernel
      .split("async function runCase", 2)[1]
      ?.split("let executable", 1)[0];
    expect(proofContainer).toBeDefined();
    expect(proofContainer).not.toMatch(
      /(?:packageDirectory|CARGO_HOME|\/workspace|\/cargo|\/target|credential|browser|docker\.sock|systemd|service)/iu,
    );
    expect(proofContainer).not.toContain("result.stderr.trim()");
  });
});
