// The per-user browser settings for the live view.
//
// A file rather than environment variables, because OpenChamber hands an
// extension service only a fixed allowlist of inherited variables (see
// chrome-path.ts). It lives at
// `$XDG_CONFIG_HOME/openchamber/design-studio/browser.json` (or
// `~/.config/openchamber/design-studio/browser.json`), and both launch modes
// read it:
//
//   { "path": "/usr/bin/chromium",             // launch this executable
//     "cdpEndpoint": "http://sidecar:9222" }   // or drive that browser over CDP
//
// With `cdpEndpoint` set the service ATTACHES: it drives a browser it did not
// start and never kills it. Without one it launches `path`, or the executable
// chrome-path.ts resolves. The endpoint is any CDP debugging address — a sidecar
// container's `--remote-debugging-port`, or a broker like Browserless; both
// answer `/json/version` and speak CDP on the websocket they report.
//
// Validation is strict and fatal: an unusable setting is an error naming the
// file and the field, never a silent fallback to a browser the user did not ask
// for. Unknown keys are ignored, so the file can grow without breaking older
// builds.
import { readFileSync } from 'node:fs';

import { envGet, firstEnv, homeDir, paths } from './platform-env.ts';

export type BrowserSettings = {
  /** The executable to launch. Absent means "resolve it" (PATH, then defaults). */
  path?: string;
  /** A browser to drive over CDP instead of launching one. */
  cdpEndpoint?: string;
  /** Where these settings came from; named in every error message. */
  file: string;
  /** Set when the file exists but cannot be used: callers must refuse. */
  error?: string;
};

/** Where the settings live, relative to the config directory. */
export const BROWSER_CONFIG_REL = 'openchamber/design-studio/browser.json';

/**
 * Where the settings are looked for: `$XDG_CONFIG_HOME` first, then `%APPDATA%`
 * on Windows, then `~/.config` (the XDG default).
 */
export function browserConfigPath(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  const p = paths(platform);
  const xdg = envGet(env, 'XDG_CONFIG_HOME')?.trim();
  if (xdg) return p.join(xdg, BROWSER_CONFIG_REL);
  if (platform === 'win32') {
    const appData = firstEnv(env, 'APPDATA');
    if (appData) return p.join(appData, BROWSER_CONFIG_REL);
  }
  const home = homeDir(env);
  return home ? p.join(home, '.config', BROWSER_CONFIG_REL) : BROWSER_CONFIG_REL;
}

/** A non-empty string when the value is one, else null. */
function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Whether a configured endpoint is an address a CDP client can dial. */
function isCdpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') &&
      url.host !== ''
    );
  } catch {
    return false;
  }
}

/**
 * Parse the settings file. `readFile` returns its text, or null when there is no
 * such file; everything else is this function's business, so the rules are
 * testable without a filesystem.
 */
export function parseBrowserSettings(
  text: string | null,
  file: string,
): BrowserSettings {
  if (text === null) return { file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { file, error: `${file} is not valid JSON.` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { file, error: `${file} must contain a JSON object.` };
  }
  const record = parsed as { path?: unknown; cdpEndpoint?: unknown };

  const settings: BrowserSettings = { file };
  if (record.path !== undefined) {
    const value = nonBlankString(record.path);
    if (value === null) return { file, error: `${file} has a "path" that is not a non-empty string.` };
    settings.path = value;
  }
  if (record.cdpEndpoint !== undefined) {
    const value = nonBlankString(record.cdpEndpoint);
    if (value === null || !isCdpEndpoint(value)) {
      return { file, error: `${file} has a "cdpEndpoint" that is not an http(s) or ws(s) URL.` };
    }
    settings.cdpEndpoint = value;
  }
  return settings;
}

/** The settings on this machine, read from the config file. */
export function readBrowserSettings(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  readFile: (abs: string) => string | null = defaultReadFile,
): BrowserSettings {
  const file = browserConfigPath(env, platform);
  return parseBrowserSettings(readFile(file), file);
}

function defaultReadFile(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Where the browser's own `/json/version` lives for an http(s) endpoint. */
export function cdpVersionUrl(endpoint: string): string | null {
  const url = new URL(endpoint);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return null;
  return new URL('/json/version', url).href;
}

/**
 * The websocket to speak CDP on, from the configured endpoint and the browser's
 * `/json/version` answer. A `ws(s)://` endpoint is dialled as given. Otherwise
 * the reported `webSocketDebuggerUrl` is RE-HOMED onto the endpoint's own host
 * and port, keeping its path: a broker that answers with its bind address
 * (`ws://0.0.0.0:3000/`, which nothing can dial) still connects, and a plain
 * Chromium's `/devtools/browser/<uuid>` path survives the rewrite.
 */
export function cdpSocketUrl(endpoint: string, version: { webSocketDebuggerUrl?: unknown }): string | null {
  const url = new URL(endpoint);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
  const reported = nonBlankString(version.webSocketDebuggerUrl);
  if (reported === null) return null;
  let ws: URL;
  try {
    ws = new URL(reported);
  } catch {
    return null;
  }
  if (ws.protocol !== 'ws:' && ws.protocol !== 'wss:') return null;
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(`${scheme}//${url.host}${ws.pathname}${ws.search}`).href;
}
