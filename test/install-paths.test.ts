import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { dataDir, defaultDataDir, envFilesToLoad, resolvePaths, unset } from "../src/install/paths.js";

const home = resolve("/Users/sam");

describe("where an installed newsletter keeps its data", () => {
  it("treats empty and unsubstituted values as unset", () => {
    expect(unset(undefined)).toBe(true);
    expect(unset("")).toBe(true);
    expect(unset("   ")).toBe(true);
    expect(unset("${user_config.data_dir}")).toBe(true);
    expect(unset("C:\\data")).toBe(false);
  });

  it("defaults to each OS's per-user data folder", () => {
    expect(defaultDataDir({ LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" }, "win32", "C:\\Users\\sam")).toBe(join("C:\\Users\\sam\\AppData\\Local", "volta-newsletter"));
    expect(defaultDataDir({}, "win32", "C:\\Users\\sam")).toBe(join("C:\\Users\\sam", "AppData", "Local", "volta-newsletter"));
    expect(defaultDataDir({}, "darwin", home)).toBe(join(home, "Library", "Application Support", "volta-newsletter"));
    expect(defaultDataDir({}, "linux", home)).toBe(join(home, ".local", "share", "volta-newsletter"));
    expect(defaultDataDir({ XDG_DATA_HOME: "/srv/data" }, "linux", home)).toBe(join("/srv/data", "volta-newsletter"));
  });

  it("VOLTA_NEWSLETTER_HOME moves everything, and each path can still be overridden on its own", () => {
    const base = resolve("/srv/newsletter");
    const p = resolvePaths({ VOLTA_NEWSLETTER_HOME: base }, { platform: "linux", home, packagedConfig: "/pkg/config/default.json" });
    expect(p).toEqual({
      dataDir: base, outDir: base,
      databasePath: join(base, "newsletter.sqlite"), alertsLog: join(base, "alerts.log"),
      configPath: "/pkg/config/default.json",
    });
    const own = resolvePaths({ VOLTA_NEWSLETTER_HOME: base, DATABASE_PATH: "/db/n.sqlite", OUT_DIR: "/tmp/out", CONFIG_PATH: "/etc/n.json" }, { platform: "linux", home });
    expect(own.databasePath).toBe(resolve("/db/n.sqlite"));
    expect(own.outDir).toBe(resolve("/tmp/out"));
    expect(own.alertsLog).toBe(join(resolve("/tmp/out"), "alerts.log"));
    expect(own.configPath).toBe(resolve("/etc/n.json"));
  });

  it("falls back to the default when the host hands over an empty or unsubstituted value", () => {
    expect(dataDir({ VOLTA_NEWSLETTER_HOME: "" }, { platform: "linux", home })).toBe(join(home, ".local", "share", "volta-newsletter"));
    expect(dataDir({ VOLTA_NEWSLETTER_HOME: "${user_config.data_dir}" }, { platform: "linux", home })).toBe(join(home, ".local", "share", "volta-newsletter"));
  });

  it("loads the working directory's .env, then the data directory's, only when they exist", () => {
    const present = new Set([join("/work", ".env"), join("/data", ".env")]);
    expect(envFilesToLoad("/work", "/data", (p) => present.has(p))).toEqual([join("/work", ".env"), join("/data", ".env")]);
    expect(envFilesToLoad("/work", "/data", (p) => p === join("/data", ".env"))).toEqual([join("/data", ".env")]);
    expect(envFilesToLoad("/work", "/data", () => false)).toEqual([]);
    // A checkout whose data dir is its own folder is not read twice.
    expect(envFilesToLoad("/work", "/work", () => true)).toEqual([join("/work", ".env")]);
  });
});
