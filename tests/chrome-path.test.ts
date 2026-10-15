import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CHROME_CONFIG_REL,
  CHROME_PATH_ENV,
  PATH_CANDIDATES,
  browserConfigPath,
  defaultChromeCandidates,
  resolveChromeExecutable,
  type ChromeLookup,
} from '../service/chrome-path.ts';

const LINUX: NodeJS.Platform = 'linux';
const CONFIG = path.posix.join('/home/r/.config', CHROME_CONFIG_REL);

/** A lookup over a fixed env, a set of executable paths, and optional config text. */
function lookup(options: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  executables?: string[];
  config?: string | null;
} = {}): ChromeLookup {
  const executables = new Set(options.executables ?? []);
  return {
    env: options.env ?? {},
    platform: options.platform ?? LINUX,
    isExecutable: (abs) => executables.has(abs),
    readConfig: () => options.config ?? null,
  };
}

test(`${CHROME_PATH_ENV} wins when it is actually delivered`, () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { [CHROME_PATH_ENV]: '/opt/my chrome/chrome' }, executables: ['/opt/my chrome/chrome'] }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/opt/my chrome/chrome', source: 'env' });
});

test('the env variable name is matched case-insensitively (Windows spellings)', () => {
  const resolved = resolveChromeExecutable(lookup({ env: { ds_chrome_path: '/usr/bin/chromium' }, executables: ['/usr/bin/chromium'] }));
  assert.deepEqual(resolved, { ok: true, path: '/usr/bin/chromium', source: 'env' });
});

test('an unusable env path is an error, never a silent fallback', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { [CHROME_PATH_ENV]: '/gone/chrome', PATH: '/usr/bin' }, executables: ['/usr/bin/google-chrome'] }),
  );
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok === false ? resolved.error : '', /DS_CHROME_PATH is set to \/gone\/chrome/);
});

test('a path in the user config file is used, source "config"', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { HOME: '/home/r' }, executables: ['/opt/chromium'], config: JSON.stringify({ path: '/opt/chromium' }) }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/opt/chromium', source: 'config' });
});

test('~/ in the config path is expanded against HOME', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { HOME: '/home/r' }, executables: ['/home/r/bin/chrome'], config: JSON.stringify({ path: '~/bin/chrome' }) }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/home/r/bin/chrome', source: 'config' });
});

test('a config path that is not executable names both the file and the path', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { HOME: '/home/r' }, config: JSON.stringify({ path: '/opt/nope' }) }),
  );
  assert.equal(resolved.ok, false);
  const error = resolved.ok === false ? resolved.error : '';
  assert.match(error, /\/home\/r\/\.config\/openchamber\/design-studio\/browser\.json/);
  assert.match(error, /\/opt\/nope/);
});

test('a malformed config file is reported, not ignored', () => {
  const broken = resolveChromeExecutable(lookup({ env: { HOME: '/home/r' }, config: '{ not json' }));
  assert.equal(broken.ok, false);
  assert.match(broken.ok === false ? broken.error : '', /is not valid JSON/);

  const wrongType = resolveChromeExecutable(lookup({ env: { HOME: '/home/r' }, config: JSON.stringify({ path: 7 }) }));
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.ok === false ? wrongType.error : '', /"path" that is not a non-empty string/);
});

test('a config file without a path falls through to PATH', () => {
  const resolved = resolveChromeExecutable(
    lookup({
      env: { HOME: '/home/r', PATH: '/usr/bin' },
      executables: ['/usr/bin/chromium'],
      config: JSON.stringify({ headless: true }),
    }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/usr/bin/chromium', source: 'path' });
});

test('PATH is probed candidate by candidate, in order, across every entry', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { PATH: '/first:/second' }, executables: ['/second/chromium'] }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/second/chromium', source: 'path' });

  // google-chrome outranks chromium, whichever directory holds which.
  const ordered = resolveChromeExecutable(
    lookup({ env: { PATH: '/a:/b' }, executables: ['/a/chromium', '/b/google-chrome'] }),
  );
  assert.deepEqual(ordered, { ok: true, path: '/b/google-chrome', source: 'path' });
});

test('blank and quoted PATH entries are skipped', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { PATH: '::"/usr/bin": ' }, executables: ['/usr/bin/chrome'] }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/usr/bin/chrome', source: 'path' });
});

test('the platform install locations are the last resort', () => {
  const linux = resolveChromeExecutable(
    lookup({ env: { PATH: '/nothing' }, executables: ['/usr/bin/google-chrome-stable'] }),
  );
  assert.deepEqual(linux, { ok: true, path: '/usr/bin/google-chrome-stable', source: 'default' });

  const darwin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const mac = resolveChromeExecutable(
    lookup({ platform: 'darwin', env: {}, executables: [darwin] }),
  );
  assert.deepEqual(mac, { ok: true, path: darwin, source: 'default' });
});

test('Windows defaults come from PROGRAMFILES and probe .exe on PATH', () => {
  const expected = path.win32.join('C:\\Program Files', 'Google/Chrome/Application/chrome.exe');
  const viaDefault = resolveChromeExecutable(
    lookup({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' }, executables: [expected] }),
  );
  assert.deepEqual(viaDefault, { ok: true, path: expected, source: 'default' });

  const viaPath = resolveChromeExecutable(
    lookup({
      platform: 'win32',
      env: { PATH: 'C:\\Chrome' },
      executables: [path.win32.join('C:\\Chrome', 'chrome.exe')],
    }),
  );
  assert.deepEqual(viaPath, { ok: true, path: path.win32.join('C:\\Chrome', 'chrome.exe'), source: 'path' });
});

test('nothing found: the error says what to do and where it looked', () => {
  const resolved = resolveChromeExecutable(lookup({ env: { HOME: '/home/r', PATH: '/usr/bin' } }));
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.error, /No Chrome or Chromium found/);
  assert.match(resolved.error, /\/home\/r\/\.config\/openchamber\/design-studio\/browser\.json/);
  assert.match(resolved.error, /DS_CHROME_PATH/);
  assert.ok(resolved.tried.includes(CONFIG), 'the config file it looked at is recorded');
  assert.ok(resolved.tried.includes('/usr/bin/google-chrome'), 'PATH candidates are recorded');
  assert.ok(resolved.tried.length >= PATH_CANDIDATES.length, 'every candidate is recorded');
});

test('browserConfigPath follows XDG_CONFIG_HOME, then HOME, then %APPDATA%', () => {
  assert.equal(
    browserConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/r' }, LINUX),
    path.posix.join('/xdg', CHROME_CONFIG_REL),
  );
  assert.equal(browserConfigPath({ HOME: '/home/r' }, LINUX), path.posix.join('/home/r/.config', CHROME_CONFIG_REL));
  assert.equal(
    browserConfigPath({ APPDATA: 'C:\\Users\\r\\AppData\\Roaming' }, 'win32'),
    path.win32.join('C:\\Users\\r\\AppData\\Roaming', CHROME_CONFIG_REL),
  );
});

test('defaultChromeCandidates describes each platform', () => {
  const linux = defaultChromeCandidates({}, LINUX);
  assert.ok(linux.includes('/usr/bin/google-chrome') && linux.includes('/usr/bin/chromium'));
  const mac = defaultChromeCandidates({ HOME: '/Users/r' }, 'darwin');
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(mac.includes(path.posix.join('/Users/r', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')));
  assert.deepEqual(defaultChromeCandidates({ PROGRAMFILES: '' }, 'win32'), []);
});

// The hardcoded macOS path is what made every non-macOS install fail; the
// launcher must resolve rather than assume.
test('the live window resolves its browser instead of hardcoding one', async () => {
  const source = await readFile(new URL('../service/browser.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ findChrome, type ChromeSource \} from '\.\/chrome-path\.ts'/, 'the launcher uses the resolver');
  assert.match(source, /const chromeBin = findChrome\(\)/, 'resolution happens at launch');
  assert.match(source, /if \(!chromeBin\.ok\) throw new Error\(chromeBin\.error\)/, 'a missing browser fails loudly');
  assert.match(source, /spawn\(chromeBin\.path, buildLaunchArgs/, 'the resolved binary is what is spawned');
  assert.doesNotMatch(source, /\/Applications\/Google Chrome/, 'no hardcoded macOS path remains');
});
