import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  containedChildEmpty,
  containedChildPayloadPid,
  containedChildResult,
  containedChildSetupError,
  releaseContainedChild,
  settleContainedChild,
  signalContainedChild,
  spawnContained,
} from "../scripts/child-containment.mjs";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const containmentModule = fileURLToPath(
  new URL("../scripts/child-containment.mjs", import.meta.url),
);

async function waitFor(predicate: () => boolean, label: string, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} deadline expired`);
    await delay(10);
  }
}

function exactCgroupPath(pid: number): string {
  const record = readFileSync(`/proc/${pid}/cgroup`, "ascii");
  const match = /^0::(?<path>\/[A-Za-z0-9_.@/-]+)\n$/u.exec(record);
  if (
    match?.groups?.path === undefined ||
    !/\/openspell-wp201-child-[0-9a-f]{64}$/u.test(match.groups.path)
  ) {
    throw new Error("contained guardian cgroup path invalid");
  }
  return join("/sys/fs/cgroup", match.groups.path.slice(1));
}

async function waitForClose(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) await once(child, "close");
}

function processStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "ascii");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("process stat malformed");
  const value = stat.slice(close + 2).trimEnd().split(" ")[19];
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("process start time malformed");
  }
  return value;
}

function writeMarkerProgram(marker: string, value: string): string {
  return `
    import { writeFile } from "node:fs/promises";
    await writeFile(${JSON.stringify(marker)}, ${JSON.stringify(value)});
  `;
}

describe("WP-201 cgroup guardian containment", () => {
  it("routes every production payload spawn through the fixed guardian", () => {
    const scripts = [
      "cargo.mjs",
      "docker-integration.mjs",
      "interruption-harness.mjs",
      "test.mjs",
      "child-containment.mjs",
      "child-containment-launcher.mjs",
    ];
    const raw = scripts.flatMap((name) => {
      const source = readFileSync(join(packageDirectory, "scripts", name), "utf8");
      return [...source.matchAll(/\bspawn\(/gu)].map((match) => ({ name, offset: match.index }));
    });
    expect(raw).toEqual([
      expect.objectContaining({ name: "child-containment-launcher.mjs" }),
    ]);
  });

  it("keeps the payload unreachable until the one-use release settles", async () => {
    const marker = join("/tmp", `openspell-wp201-release-${randomBytes(16).toString("hex")}`);
    const child = spawnContained(
      spawn,
      process.execPath,
      ["--input-type=module", "--eval", writeMarkerProgram(marker, "released")],
      {
        cwd: "/",
        env: { LANG: "C", LC_ALL: "C" },
        holdRelease: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const cgroupPath = exactCgroupPath(child.pid!);
    try {
      expect(readFileSync(join(cgroupPath, "cgroup.procs"), "ascii")).toBe(`${child.pid}\n`);
      await delay(50);
      expect(existsSync(marker)).toBe(false);
      expect(containedChildPayloadPid(child)).toBeUndefined();
      releaseContainedChild(child);
      await waitForClose(child);
      await waitFor(() => containedChildResult(child) !== undefined, "payload result");
      expect(containedChildResult(child)).toEqual({ code: 0, signal: null });
      expect(readFileSync(marker, "utf8")).toBe("released");
      expect(containedChildSetupError(child)).toBeUndefined();
      expect(settleContainedChild(child)).toMatchObject({ empty: true, settled: true });
      expect(existsSync(cgroupPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        signalContainedChild(child, "SIGKILL");
        await waitForClose(child);
      }
      if (existsSync(cgroupPath)) {
        writeFileSync(join(cgroupPath, "cgroup.kill"), "1");
        await waitFor(() => readFileSync(join(cgroupPath, "cgroup.events"), "ascii").startsWith("populated 0\n"), "cgroup drain");
        rmdirSync(cgroupPath);
      }
      rmSync(marker, { force: true });
    }
  });

  it("kills same-group and detached descendants without touching an unrelated process", async () => {
    const unrelated = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    await once(unrelated, "spawn");
    const unrelatedStart = processStartTime(unrelated.pid!);
    const payload = String.raw`
      import { spawn } from "node:child_process";
      const same = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      const detached = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
      same.unref();
      detached.unref();
      process.stdout.write(JSON.stringify({ same: same.pid, detached: detached.pid }) + "\n");
    `;
    const child = spawnContained(spawn, process.execPath, ["--input-type=module", "--eval", payload], {
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    });
    try {
      await waitFor(() => stdout.includes(0x0a), "descendant identity");
      const identities = JSON.parse(stdout.toString("utf8")) as { same: number; detached: number };
      await waitFor(() => containedChildPayloadPid(child) !== undefined, "payload identity");
      signalContainedChild(child, "SIGTERM");
      await delay(50);
      signalContainedChild(child, "SIGKILL");
      await waitForClose(child);
      await waitFor(() => !existsSync(`/proc/${identities.same}`), "same-group descendant reap");
      await waitFor(() => !existsSync(`/proc/${identities.detached}`), "detached descendant reap");
      expect(processStartTime(unrelated.pid!)).toBe(unrelatedStart);
      expect(containedChildEmpty(child)).toBe(true);
      expect(settleContainedChild(child)).toMatchObject({ empty: true, settled: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        signalContainedChild(child, "SIGKILL");
        await waitForClose(child);
      }
      try {
        process.kill(-(unrelated.pid ?? 0), "SIGKILL");
      } catch {
        // The unrelated control may have already terminated.
      }
      await waitForClose(unrelated);
    }
  });

  it("removes an unreleased containment when its parent dies", async () => {
    const marker = join("/tmp", `openspell-wp201-parent-death-${randomBytes(16).toString("hex")}`);
    const command = String.raw`
      import { spawn } from "node:child_process";
      import { readFileSync } from "node:fs";
      import { spawnContained } from ${JSON.stringify(pathToFileURL(containmentModule).href)};
      const child = spawnContained(spawn, process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(writeMarkerProgram(marker, "forbidden"))}], {
        cwd: "/", env: { LANG: "C", LC_ALL: "C" }, holdRelease: true, stdio: ["ignore", "ignore", "ignore"],
      });
      process.stdout.write(JSON.stringify({ pid: child.pid, cgroup: readFileSync("/proc/" + child.pid + "/cgroup", "ascii") }) + "\n");
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["--input-type=module", "--eval", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    parent.stdout!.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    });
    let guardianPid: number | undefined;
    let cgroupPath: string | undefined;
    try {
      await waitFor(() => stdout.includes(0x0a), "parent-death fixture ready");
      const record = JSON.parse(stdout.toString("utf8")) as { pid: number; cgroup: string };
      guardianPid = record.pid;
      const match = /^0::(?<path>\/[A-Za-z0-9_.@/-]+)\n$/u.exec(record.cgroup);
      if (match?.groups?.path === undefined) throw new Error("parent-death cgroup record invalid");
      cgroupPath = join("/sys/fs/cgroup", match.groups.path.slice(1));
      parent.kill("SIGKILL");
      await waitForClose(parent);
      await waitFor(() => !existsSync(`/proc/${guardianPid}`), "orphan guardian reap");
      await waitFor(() => !existsSync(cgroupPath!), "orphan cgroup removal");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill("SIGKILL");
        await waitForClose(parent);
      }
      if (guardianPid !== undefined && existsSync(`/proc/${guardianPid}`)) {
        process.kill(guardianPid, "SIGKILL");
      }
      if (cgroupPath !== undefined && existsSync(cgroupPath)) {
        writeFileSync(join(cgroupPath, "cgroup.kill"), "1");
        await waitFor(() => readFileSync(join(cgroupPath!, "cgroup.events"), "ascii").startsWith("populated 0\n"), "orphan cgroup drain");
        rmdirSync(cgroupPath);
      }
      rmSync(marker, { force: true });
    }
  });
});
