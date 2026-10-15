// Platform and environment spelling, shared by the modules that read the user's
// machine: the executable lookup (chrome-path.ts) and the settings file
// (browser-settings.ts). Both must answer for a platform and an environment they
// are handed rather than the ones they happen to run on, or their rules could not
// be tested for macOS and Windows at all.
import path from 'node:path';

/** The path utilities for a platform, so a darwin/win32 answer is host-agnostic. */
export function paths(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Environment lookup that tolerates Windows' case-insensitive names: the exact
 * spelling first, then any casing of it.
 */
export function envGet(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/** The first non-blank of the named variables, trimmed. */
export function firstEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = envGet(env, name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The user's home directory, by the spelling the platform uses. */
export function homeDir(env: Record<string, string | undefined>): string | undefined {
  const home = firstEnv(env, 'HOME', 'USERPROFILE');
  if (home) return home;
  const drive = envGet(env, 'HOMEDRIVE')?.trim();
  const share = envGet(env, 'HOMEPATH')?.trim();
  return drive && share ? `${drive}${share}` : undefined;
}

/** `~/…` against the home directory; every other spelling is returned as given. */
export function expandHome(value: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (!value.startsWith('~/') && !value.startsWith('~\\')) return value;
  const home = homeDir(env);
  return home ? paths(platform).join(home, value.slice(2)) : value;
}
