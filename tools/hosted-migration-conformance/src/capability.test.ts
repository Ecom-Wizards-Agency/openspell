import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import ts from "typescript";

import * as publicApi from "./index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "src");
const productionFiles = [
  "canonical.ts",
  "crypto.ts",
  "derivations.ts",
  "index.ts",
  "records.ts",
  "session.ts",
  "transcript.ts",
  "types.ts",
] as const;
const allSourceFiles = [...productionFiles, "capability.test.ts", "conformance.test.ts"].sort();

const allowedImports = {
  "canonical.ts": ["./records.js", "./types.js"],
  "crypto.ts": ["./canonical.js", "./types.js", "node:crypto"],
  "derivations.ts": ["./crypto.js", "./session.js", "./types.js", "node:crypto"],
  "index.ts": ["./crypto.js", "./derivations.js", "./transcript.js", "./types.js"],
  "records.ts": ["./types.js"],
  "session.ts": ["./records.js", "./types.js", "node:crypto"],
  "transcript.ts": ["./crypto.js", "./derivations.js", "./types.js"],
  "types.ts": [],
} as const satisfies Record<(typeof productionFiles)[number], readonly string[]>;

const allowedCryptoBindings = {
  "canonical.ts": [],
  "crypto.ts": ["createHash", "createPublicKey", "type KeyObject", "verify as verifyEd25519"],
  "derivations.ts": ["createHash"],
  "index.ts": [],
  "records.ts": [],
  "session.ts": ["createHash"],
  "transcript.ts": [],
  "types.ts": [],
} as const satisfies Record<(typeof productionFiles)[number], readonly string[]>;

const allowedReExports = {
  "canonical.ts": [],
  "crypto.ts": [],
  "derivations.ts": [],
  "index.ts": [
    "export ./crypto.js {verifySignedLeaf}",
    "export ./derivations.js {derivePhaseSessionTag,verifyRuntimeAttestationChain}",
    "export ./transcript.js {verifyApplyTranscript,verifyPreparationTranscript}",
    "export ./types.js {LEAF_SCHEMA_VERSIONS,REFUSAL_CODES}",
    "export type ./types.js {ApplyTranscriptInput,ApprovalGrantLeaf,AttestationChainEvidence,ConformanceResult,ExecutionEvidenceLeaves,ExecutionTicketLeaf,ExternalWindowLeaf,LeafSchemaVersion,MigrationLeaf,NoExecutionResultLeaf,Phase,PhaseAuthorizationKind,PhaseTranscriptEvidence,PreparationNoExecutionResultLeaf,PreparationPhase,PreparationTicketLeaf,PreparationTranscriptInput,ReducedPhaseState,RefusalCode,RuntimeAttestationLeaf,SignedLeafEvidence,SignedLeafInput,TerminalExecGraphLeaf}",
  ],
  "records.ts": [],
  "session.ts": [],
  "transcript.ts": [],
  "types.ts": [],
} as const satisfies Record<(typeof productionFiles)[number], readonly string[]>;

function moduleSpecifiers(source: string): string[] {
  const from = [...source.matchAll(/\b(?:from|import)\s+["']([^"']+)["']/gu)].map(
    (match) => match[1] as string,
  );
  return [...new Set(from)].sort();
}

function cryptoBindings(source: string): string[] {
  const sourceFile = ts.createSourceFile("capability.ts", source, ts.ScriptTarget.Latest, true);
  const bindings: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "node:crypto"
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name !== undefined) bindings.push(`default as ${clause.name.text}`);
    const named = clause?.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) {
      bindings.push(`* as ${named.name.text}`);
    }
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        const alias = element.propertyName === undefined ? "" : ` as ${element.name.text}`;
        bindings.push(`${element.isTypeOnly ? "type " : ""}${imported}${alias}`);
      }
    }
  }
  return bindings.sort();
}

function reExportEdges(source: string): string[] {
  const sourceFile = ts.createSourceFile("capability.ts", source, ts.ScriptTarget.Latest, true);
  const edges: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    if (statement.exportClause === undefined) {
      edges.push(`${statement.isTypeOnly ? "export type" : "export"} ${module} {*}`);
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      edges.push(`export ${module} {* as ${statement.exportClause.name.text}}`);
      continue;
    }
    const bindings = statement.exportClause.elements
      .map((element) => {
        const imported = element.propertyName?.text ?? element.name.text;
        const alias = element.propertyName === undefined ? "" : ` as ${element.name.text}`;
        return `${element.isTypeOnly ? "type " : ""}${imported}${alias}`;
      })
      .sort();
    edges.push(
      `${statement.isTypeOnly ? "export type" : "export"} ${module} {${bindings.join(",")}}`,
    );
  }
  return edges.sort();
}

describe("static capability boundary", () => {
  it("pins the complete source and public module graph", () => {
    expect(readdirSync(sourceRoot).filter((name) => name.endsWith(".ts")).sort()).toEqual(
      allSourceFiles,
    );
    for (const file of productionFiles) {
      const source = readFileSync(join(sourceRoot, file), "utf8");
      expect(moduleSpecifiers(source), file).toEqual([...allowedImports[file]].sort());
      expect(cryptoBindings(source), `${file} node:crypto symbols`).toEqual(
        [...allowedCryptoBindings[file]].sort(),
      );
      expect(reExportEdges(source), `${file} re-export edges`).toEqual(
        [...allowedReExports[file]].sort(),
      );
    }
    expect(Object.keys(publicApi).sort()).toEqual([
      "LEAF_SCHEMA_VERSIONS",
      "REFUSAL_CODES",
      "derivePhaseSessionTag",
      "verifyApplyTranscript",
      "verifyPreparationTranscript",
      "verifyRuntimeAttestationChain",
      "verifySignedLeaf",
    ]);
    expect(Object.isFrozen(publicApi.LEAF_SCHEMA_VERSIONS)).toBe(true);
    expect(Object.isFrozen(publicApi.REFUSAL_CODES)).toBe(true);
  });

  it("pins library-only package metadata with no runtime dependency or lifecycle hook", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(packageJson)).toEqual([
      "name",
      "version",
      "private",
      "type",
      "exports",
      "scripts",
      "devDependencies",
    ]);
    expect(packageJson).toEqual({
      name: "@wizard-ads/hosted-migration-conformance",
      version: "0.0.0",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run --passWithNoTests",
      },
      devDependencies: { "@types/node": "^22.20.1" },
    });
  });

  it("denies dynamic, external-state, signing, random and native-addon reachability", () => {
    for (const file of productionFiles) {
      const source = readFileSync(join(sourceRoot, file), "utf8");
      expect(source, file).not.toMatch(/\bimport\s*\(/u);
      expect(source, file).not.toMatch(/\b(?:eval|require|Function)\s*\(/u);
      expect(source, file).not.toMatch(/\bglobalThis\b/u);
      expect(source, file).not.toMatch(/\bprocess\s*(?:\.|\[)/u);
      expect(source, file).not.toMatch(
        /\b(?:fetch|WebSocket|XMLHttpRequest|EventSource|SharedWorker|Deno|Bun|WebAssembly)\s*(?:\(|\.|\[)/u,
      );
      expect(source, file).not.toMatch(/\b(?:spawn|spawnSync|exec|execFile|fork)\s*\(/u);
      expect(source, file).not.toMatch(
        /\b(?:sign|createSign|generateKeyPair|generateKeyPairSync|createPrivateKey|randomBytes|randomFill|randomInt|randomUUID)\s*\(/u,
      );
      expect(source, file).not.toMatch(/\.(?:node)(?:["']|\b)/u);
      expect(source, file).not.toMatch(
        /\b(?:projectRef|databaseUrl|hostname|command|environment|callback|filePath|workdir)\b/u,
      );
    }
  });

  it("detects aliased crypto imports and re-exports", () => {
    expect(cryptoBindings('import { sign as verifyEd25519 } from "node:crypto";')).not.toEqual(
      allowedCryptoBindings["crypto.ts"],
    );
    for (const symbol of ["sign", "randomBytes", "createPrivateKey"]) {
      expect(reExportEdges(`export { ${symbol} as delegated } from "node:crypto";`)).toEqual([
        `export node:crypto {${symbol} as delegated}`,
      ]);
    }
  });
});
