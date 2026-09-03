import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

import { runCargo } from "./cargo.mjs";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const forwarded = process.argv.slice(2);
if (
  forwarded.length > 1 ||
  (forwarded.length === 1 && forwarded[0] !== "--maxWorkers=1")
) {
  throw new Error("only the repository --maxWorkers=1 test argument is accepted");
}

const cargoStatus = runCargo("test");
if (cargoStatus !== 0) process.exit(cargoStatus);

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--passWithNoTests",
    ...(forwarded.length === 0 ? [] : ["--maxWorkers=1"]),
  ],
  { cwd: packageDirectory, encoding: "utf8", stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
