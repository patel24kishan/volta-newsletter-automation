/**
 * Integration: `volta-newsletter reminder` as Task Scheduler or cron runs it — a child process,
 * from some other folder, with only environment variables. A quiet day exits 0 and prints
 * NOTHING_DUE; the notifier is switched off so nothing pops up on the machine running the tests.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");
const main = join(repo, "src", "cli", "main.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const run = promisify(execFile);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "volta-remcli-")); mkdirSync(join(dir, "elsewhere")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the reminder command as a scheduler runs it", { timeout: 60_000 }, () => {
  it("exits 0 and says NOTHING_DUE on a quiet morning, touching only its data folder", async () => {
    const data = join(dir, "data");
    const { stdout } = await run(process.execPath, [tsxCli, main, "reminder"], {
      cwd: join(dir, "elsewhere"),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        VOLTA_NEWSLETTER_HOME: data, DEMO_NOW: "2026-10-01T11:29:00Z", ALLOW_LIVE: "0", VOLTA_NEWSLETTER_NOTIFIER: "none",
      },
    });
    expect(stdout.split("\n")[0]).toBe("NOTHING_DUE");
    expect(stdout).toContain("October's newsletter is due Thursday 1 October at 08:30.");
    expect(existsSync(join(data, "newsletter.sqlite"))).toBe(true);
  });
});
