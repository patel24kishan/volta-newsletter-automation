/**
 * Where the newsletter keeps its data when it is installed rather than run from a checkout.
 *
 * The package directory is replaced on every update (npx cache, extension bundle), so the
 * database, the built drafts and the alerts log live in a folder of the user's own. Every path
 * here is pure: the environment, platform and home folder are passed in, so tests need no
 * real machine.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The one variable that moves everything: the data directory. */
export const DATA_DIR_ENV = "VOLTA_NEWSLETTER_HOME";
export const DIR_NAME = "volta-newsletter";

/** The config shipped in the package: two levels up from src/cli and dist/cli alike. */
export const PACKAGED_CONFIG = resolve(import.meta.dirname, "../../config/default.json");

export interface PathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Overrides PACKAGED_CONFIG; for tests. */
  packagedConfig?: string;
}

export interface Paths {
  dataDir: string;
  outDir: string;
  databasePath: string;
  alertsLog: string;
  configPath: string;
}

/**
 * A value the host never filled in. An extension host substitutes "${user_config.x}" only when
 * the user set it; an empty box arrives as "" or as the untouched placeholder. Both mean "use
 * the default", never "use a folder literally called ${user_config.x}".
 */
export function unset(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  return v === "" || v.startsWith("${");
}

/** The per-OS default: %LOCALAPPDATA%, ~/Library/Application Support, or $XDG_DATA_HOME. */
export function defaultDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") {
    const local = unset(env.LOCALAPPDATA) ? join(home, "AppData", "Local") : env.LOCALAPPDATA!;
    return join(local, DIR_NAME);
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", DIR_NAME);
  const base = unset(env.XDG_DATA_HOME) ? join(home, ".local", "share") : env.XDG_DATA_HOME!;
  return join(base, DIR_NAME);
}

export function dataDir(env: NodeJS.ProcessEnv, o: PathOptions = {}): string {
  const v = env[DATA_DIR_ENV];
  return unset(v) ? defaultDataDir(env, o.platform, o.home) : resolve(v!);
}

/**
 * Every path the server needs. Each may be overridden on its own (OUT_DIR, DATABASE_PATH,
 * CONFIG_PATH); otherwise all of them hang off the data directory, and the config is the one
 * shipped in the package.
 */
export function resolvePaths(env: NodeJS.ProcessEnv, o: PathOptions = {}): Paths {
  const data = dataDir(env, o);
  const outDir = unset(env.OUT_DIR) ? data : resolve(env.OUT_DIR!);
  return {
    dataDir: data,
    outDir,
    databasePath: unset(env.DATABASE_PATH) ? join(data, "newsletter.sqlite") : resolve(env.DATABASE_PATH!),
    alertsLog: join(outDir, "alerts.log"),
    configPath: unset(env.CONFIG_PATH) ? (o.packagedConfig ?? PACKAGED_CONFIG) : resolve(env.CONFIG_PATH!),
  };
}

/**
 * The .env files worth loading, in order: the working directory's (a checkout), then the data
 * directory's (an install, where a scheduled run has no other way to get its settings). Only
 * files that exist; a real environment variable always wins over either.
 */
export function envFilesToLoad(cwd: string, data: string, exists: (p: string) => boolean = existsSync): string[] {
  return [...new Set([join(cwd, ".env"), join(data, ".env")])].filter((p) => exists(p));
}
