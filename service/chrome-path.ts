// Finding the browser executable to launch.
//
// The macOS path used to be the only one, with `DS_CHROME_PATH` as the escape
// hatch for anywhere else. That hatch never works inside OpenChamber: the host
// spawns an extension service with a fixed allowlist of inherited variables
// (server/lib/guests/service.js — PATH, HOME, USER, TMPDIR, locale and XDG
// entries, and nothing else), so however the user exports DS_CHROME_PATH it
// cannot reach this process. `PATH` and `HOME` do arrive, and so does the
// settings file (browser-settings.ts).
//
// Resolution order, first hit wins:
//
//   1. `DS_CHROME_PATH`              — authoritative when actually delivered
//   2. `path` from browser.json      — authoritative when it names one
//   3. the entries on `PATH`         — google-chrome, chromium, chrome, …
//   4. the platform's install locations
//
// Explicit sources are authoritative rather than advisory: a `DS_CHROME_PATH` or
// a settings `path` that names something which is not executable is reported as
// an error, never silently skipped, because falling back would hide the
// misconfiguration behind a browser the user did not ask for.
import { accessSync, constants, statSync } from 'node:fs';

import { envGet, expandHome, homeDir, paths } from './platform-env.ts';

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
  /** `path` from browser.json, when it named one. */
  configuredPath?: string;
  /** The settings file a bad `configuredPath` is reported against. */
  configFile: string;
};

/** The environment variable that still wins when it is actually delivered. */
export const CHROME_PATH_ENV = 'DS_CHROME_PATH';

/** Names probed on `PATH`, in preference order. */
export const PATH_CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'chrome-headless-shell',
];

/** One entry per `PATH` segment, in order, blank segments and quotes dropped. */
function pathEntries(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = envGet(env, 'PATH') ?? '';
  return raw
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry !== '');
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

/**
 * The executable the live view should launch, or a failure that says what to fix.
 * Pure: every fs and env read arrives through `lookup`.
 */
export function resolveChromeExecutable(lookup: ChromeLookup): ChromeResolution {
  const { env, platform, isExecutable, configFile } = lookup;
  const p = paths(platform);
  const tried: string[] = [];

  const explicit = envGet(env, CHROME_PATH_ENV)?.trim();
  if (explicit) {
    tried.push(explicit);
    if (isExecutable(explicit)) return { ok: true, path: explicit, source: 'env' };
    return { ok: false, tried, error: `${CHROME_PATH_ENV} is set to ${explicit}, which is not an executable file.` };
  }

  if (lookup.configuredPath !== undefined) {
    const abs = expandHome(lookup.configuredPath, env, platform);
    tried.push(abs);
    if (isExecutable(abs)) return { ok: true, path: abs, source: 'config' };
    return { ok: false, tried, error: `${configFile} names ${abs}, which is not an executable file.` };
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
      `No Chrome or Chromium found. Put the browser's path in ${configFile} as {"path":"…"}` +
      ` (or set ${CHROME_PATH_ENV}), or install Chrome. Tried ${tried.length} locations.`,
  };
}

/** True when `abs` is a regular file this process may execute. */
export function isExecutableFile(abs: string): boolean {
  try {
    if (!statSync(abs).isFile()) return false;
    accessSync(abs, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
