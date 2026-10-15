// Finding the browser executable the live view runs in.
//
// The macOS path used to be the only one, with `DS_CHROME_PATH` as the escape
// hatch for anywhere else. That hatch never works inside OpenChamber: the host
// spawns an extension service with a fixed allowlist of inherited variables
// (server/lib/guests/service.js — PATH, HOME, USER, TMPDIR, locale and XDG
// entries, and nothing else), so however the user exports DS_CHROME_PATH it
// cannot reach this process. `PATH` and `HOME` do arrive, and so does a file
// under the config directory.
//
// Resolution order, first hit wins:
//
//   1. `DS_CHROME_PATH`                — authoritative when set (direct runs)
//   2. `<config>/browser.json`         — authoritative when it names a path
//   3. the entries on `PATH`           — google-chrome, chromium, chrome, …
//   4. the platform's install locations
//
// A per-user file is the durable override because it survives the host's env
// allowlist, an extension update and a service restart. It is also where the
// remote-browser settings (a CDP endpoint, headless mode) will live, so its
// shape is `{ "path": "…" }` today and grows additively.
//
// Explicit sources are authoritative rather than advisory: a `DS_CHROME_PATH`
// or a `browser.json` that names something which is not executable is reported
// as an error, never silently skipped, because falling back would hide the
// misconfiguration behind a browser the user did not ask for.
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type ChromeSource = 'env' | 'config' | 'path' | 'default';

export type ChromeResolution =
  | { ok: true; path: string; source: ChromeSource }
  | { ok: false; error: string; tried: string[] };

/** The lookups a resolution may perform. Injected so tests need no filesystem. */
export type ChromeLookup = {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** True when `abs` is a file this process may execute. */
  isExecutable: (abs: string) => boolean;
  /** The browser config text, or null when there is no such file. */
  readConfig: () => string | null;
};

/** The environment variable that still wins when it is actually delivered. */
export const CHROME_PATH_ENV = 'DS_CHROME_PATH';

/** Where the per-user browser config lives, relative to the config directory. */
export const CHROME_CONFIG_REL = 'openchamber/design-studio/browser.json';

/** Names probed on `PATH`, in preference order. */
export const PATH_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'chrome-headless-shell',
];

/** The path utilities for a platform, so a darwin/win32 answer is host-agnostic. */
function paths(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Environment lookup that tolerates Windows' case-insensitive names: the exact
 * spelling first, then any casing of it.
 */
function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/** The first non-blank of the named variables, trimmed. */
function firstEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = envGet(env, name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Where the per-user browser config is looked for: `$XDG_CONFIG_HOME` first,
 * then `%APPDATA%` on Windows, then `~/.config`.
 */
export function browserConfigPath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  const p = paths(platform);
  const xdg = envGet(env, 'XDG_CONFIG_HOME')?.trim();
  if (xdg) return p.join(xdg, CHROME_CONFIG_REL);
  if (platform === 'win32') {
    const appData = firstEnv(env, 'APPDATA');
    if (appData) return p.join(appData, CHROME_CONFIG_REL);
  }
  const home = homeDir(env);
  // `~/.config` is the XDG default when XDG_CONFIG_HOME is unset.
  return home ? p.join(home, '.config', CHROME_CONFIG_REL) : CHROME_CONFIG_REL;
}

/** The user's home directory, by the spelling the platform uses. */
function homeDir(env: Record<string, string | undefined>): string | undefined {
  const home = firstEnv(env, 'HOME', 'USERPROFILE');
  if (home) return home;
  const drive = envGet(env, 'HOMEDRIVE')?.trim();
  const share = envGet(env, 'HOMEPATH')?.trim();
  return drive && share ? `${drive}${share}` : undefined;
}

/** `~/…` against the home directory; every other spelling is returned as given. */
function expandHome(value: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (!value.startsWith('~/') && !value.startsWith('~\\')) return value;
  const home = homeDir(env);
  return home ? paths(platform).join(home, value.slice(2)) : value;
}

/**
 * The install locations a platform keeps Chrome in, in preference order. These
 * are guesses about a machine we cannot see, so they are only ever consulted
 * after `PATH` has been exhausted.
 */
export function defaultChromeCandidates(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  const p = paths(platform);
  const out: string[] = [];
  if (platform === 'darwin') {
    const homes = ['/Applications'];
    const home = homeDir(env);
    if (home) homes.push(p.join(home, 'Applications'));
    for (const base of homes) {
      out.push(p.join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
      out.push(p.join(base, 'Chromium.app/Contents/MacOS/Chromium'));
      out.push(p.join(base, 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'));
    }
    return out;
  }
  if (platform === 'win32') {
    for (const root of [envGet(env, 'PROGRAMFILES'), envGet(env, 'PROGRAMFILES(X86)'), envGet(env, 'LOCALAPPDATA')]) {
      const base = root?.trim();
      if (!base) continue;
      out.push(p.join(base, 'Google/Chrome/Application/chrome.exe'));
      out.push(p.join(base, 'Chromium/Application/chrome.exe'));
    }
    return out;
  }
  out.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/bin/chromium',
    '/snap/bin/chromium',
  );
  return out;
}

/** One entry per `PATH` segment, in order, blank segments dropped. */
function pathEntries(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = envGet(env, 'PATH') ?? '';
  return raw
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry !== '');
}

/**
 * The executable the live view should launch, or a failure that says what to
 * fix. Pure: every fs and env read arrives through `lookup`.
 */
export function resolveChromeExecutable(lookup: ChromeLookup): ChromeResolution {
  const { env, platform, isExecutable, readConfig } = lookup;
  const p = paths(platform);
  const tried: string[] = [];

  const explicit = envGet(env, CHROME_PATH_ENV)?.trim();
  if (explicit) {
    tried.push(explicit);
    if (isExecutable(explicit)) return { ok: true, path: explicit, source: 'env' };
    return { ok: false, tried, error: `${CHROME_PATH_ENV} is set to ${explicit}, which is not an executable file.` };
  }

  const configPath = browserConfigPath(env, platform);
  tried.push(configPath);
  const text = readConfig();
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, tried, error: `${configPath} is not valid JSON.` };
    }
    const named = parsed && typeof parsed === 'object' ? (parsed as { path?: unknown }).path : undefined;
    if (named !== undefined) {
      if (typeof named !== 'string' || named.trim() === '') {
        return { ok: false, tried, error: `${configPath} has a "path" that is not a non-empty string.` };
      }
      const abs = expandHome(named.trim(), env, platform);
      tried.push(abs);
      if (isExecutable(abs)) return { ok: true, path: abs, source: 'config' };
      return { ok: false, tried, error: `${configPath} names ${abs}, which is not an executable file.` };
    }
  }

  const entries = pathEntries(env, platform);
  const names = platform === 'win32' ? PATH_CANDIDATES.flatMap((name) => [name, `${name}.exe`]) : PATH_CANDIDATES;
  for (const name of names) {
    for (const entry of entries) {
      const abs = p.join(entry, name);
      tried.push(abs);
      if (isExecutable(abs)) return { ok: true, path: abs, source: 'path' };
    }
  }

  for (const abs of defaultChromeCandidates(env, platform)) {
    tried.push(abs);
    if (isExecutable(abs)) return { ok: true, path: abs, source: 'default' };
  }

  return {
    ok: false,
    tried,
    error:
      `No Chrome or Chromium found. Put the browser's path in ${configPath} as {"path":"…"}` +
      ` (or set ${CHROME_PATH_ENV}), or install Chrome. Tried ${tried.length} locations.`,
  };
}

/** True when `abs` is a regular file this process may execute. */
function isExecutableFile(abs: string): boolean {
  try {
    if (!statSync(abs).isFile()) return false;
    accessSync(abs, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve against the real environment, filesystem and platform. */
export function findChrome(): ChromeResolution {
  const platform = process.platform;
  return resolveChromeExecutable({
    env: process.env,
    platform,
    isExecutable: isExecutableFile,
    readConfig: () => {
      try {
        return readFileSync(browserConfigPath(process.env, platform), 'utf8');
      } catch {
        return null;
      }
    },
  });
}
