/**
 * Which .env files the server reads, and in what order. The rule that matters: naming the data
 * directory in the environment means "this install", and a checkout's .env in whatever folder
 * the command was run from is then left alone.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFiles } from "../src/cli/bootstrap.js";

const KEYS = ["BOOTSTRAP_TEST_A", "BOOTSTRAP_TEST_B", "VOLTA_NEWSLETTER_HOME"];
let dir: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volta-envfiles-"));
  mkdirSync(join(dir, "cwd"));
  mkdirSync(join(dir, "data"));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});

describe("the .env files a run reads", () => {
  it("reads the working directory's, then the data directory's, when no data directory is named", () => {
    writeFileSync(join(dir, "cwd", ".env"), `BOOTSTRAP_TEST_A=from-cwd\nVOLTA_NEWSLETTER_HOME=${join(dir, "data").replace(/\\/g, "/")}\n`);
    writeFileSync(join(dir, "data", ".env"), "BOOTSTRAP_TEST_A=from-data\nBOOTSTRAP_TEST_B=from-data\n");
    const read = loadEnvFiles(process.env, join(dir, "cwd"), { platform: "linux", home: dir });
    expect(read).toEqual([join(dir, "cwd", ".env"), join(dir, "data", ".env")]);
    expect(process.env.BOOTSTRAP_TEST_A).toBe("from-cwd"); // the first file read wins; nothing is overridden
    expect(process.env.BOOTSTRAP_TEST_B).toBe("from-data");
  });

  it("leaves the working directory's .env alone when the data directory is named in the environment", () => {
    writeFileSync(join(dir, "cwd", ".env"), "BOOTSTRAP_TEST_A=from-cwd\n");
    writeFileSync(join(dir, "data", ".env"), "BOOTSTRAP_TEST_B=from-data\n");
    process.env.VOLTA_NEWSLETTER_HOME = join(dir, "data");
    const read = loadEnvFiles(process.env, join(dir, "cwd"));
    expect(read).toEqual([join(dir, "data", ".env")]);
    expect(process.env.BOOTSTRAP_TEST_A).toBeUndefined();
    expect(process.env.BOOTSTRAP_TEST_B).toBe("from-data");
  });
});
