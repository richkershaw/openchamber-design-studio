import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CHROME_PATH_ENV,
  PATH_CANDIDATES,
  defaultChromeCandidates,
  isExecutableFile,
  resolveChromeExecutable,
  type ChromeLookup,
} from '../service/chrome-path.ts';

const LINUX: NodeJS.Platform = 'linux';
const FILE = path.posix.join('/home/r/.config', 'openchamber/design-studio/browser.json');

/** A lookup over a fixed env, a set of executable paths, and a settings path. */
function lookup(options: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  executables?: string[];
  configuredPath?: string;
} = {}): ChromeLookup {
  const executables = new Set(options.executables ?? []);
  return {
    env: options.env ?? {},
    platform: options.platform ?? LINUX,
    isExecutable: (abs) => executables.has(abs),
    configuredPath: options.configuredPath,
    configFile: FILE,
  };
}

test(`${CHROME_PATH_ENV} wins when it is actually delivered`, () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { [CHROME_PATH_ENV]: '/opt/my chrome/chrome' }, executables: ['/opt/my chrome/chrome'] }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/opt/my chrome/chrome', source: 'env' });
});

test('the env variable name is matched case-insensitively (Windows spellings)', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { ds_chrome_path: '/usr/bin/chromium' }, executables: ['/usr/bin/chromium'] }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/usr/bin/chromium', source: 'env' });
});

test('an unusable env path is an error, never a silent fallback', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { [CHROME_PATH_ENV]: '/gone/chrome', PATH: '/usr/bin' }, executables: ['/usr/bin/google-chrome'] }),
  );
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok === false ? resolved.error : '', /DS_CHROME_PATH is set to \/gone\/chrome/);
});

test('the path named in the settings file is used, source "config"', () => {
  const resolved = resolveChromeExecutable(lookup({ configuredPath: '/opt/chromium', executables: ['/opt/chromium'] }));
  assert.deepEqual(resolved, { ok: true, path: '/opt/chromium', source: 'config' });
});

test('~/ in the settings path is expanded against HOME', () => {
  const resolved = resolveChromeExecutable(
    lookup({ env: { HOME: '/home/r' }, configuredPath: '~/bin/chrome', executables: ['/home/r/bin/chrome'] }),
  );
  assert.deepEqual(resolved, { ok: true, path: '/home/r/bin/chrome', source: 'config' });
});

test('a settings path that is not executable names the file and the path', () => {
  const resolved = resolveChromeExecutable(lookup({ configuredPath: '/opt/nope' }));
  assert.equal(resolved.ok, false);
  const error = resolved.ok === false ? resolved.error : '';
  assert.match(error, /openchamber\/design-studio\/browser\.json/);
  assert.match(error, /\/opt\/nope/);
});

test('PATH is probed candidate by candidate, in order, across every entry', () => {
  const resolved = resolveChromeExecutable(lookup({ env: { PATH: '/first:/second' }, executables: ['/second/chromium'] }));
  assert.deepEqual(resolved, { ok: true, path: '/second/chromium', source: 'path' });

  // google-chrome outranks chromium, whichever directory holds which.
  const ordered = resolveChromeExecutable(
    lookup({ env: { PATH: '/a:/b' }, executables: ['/a/chromium', '/b/google-chrome'] }),
  );
  assert.deepEqual(ordered, { ok: true, path: '/b/google-chrome', source: 'path' });
});

test('blank and quoted PATH entries are skipped', () => {
  const resolved = resolveChromeExecutable(lookup({ env: { PATH: '::"/usr/bin": ' }, executables: ['/usr/bin/chrome'] }));
  assert.deepEqual(resolved, { ok: true, path: '/usr/bin/chrome', source: 'path' });
});

test('the platform install locations are the last resort', () => {
  const linux = resolveChromeExecutable(
    lookup({ env: { PATH: '/nothing' }, executables: ['/usr/bin/google-chrome-stable'] }),
  );
  assert.deepEqual(linux, { ok: true, path: '/usr/bin/google-chrome-stable', source: 'default' });

  const darwin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const mac = resolveChromeExecutable(lookup({ platform: 'darwin', env: {}, executables: [darwin] }));
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
  assert.match(resolved.error, /openchamber\/design-studio\/browser\.json/, 'the settings file is named');
  assert.match(resolved.error, /DS_CHROME_PATH/, 'the override is named');
  assert.ok(resolved.tried.includes('/usr/bin/google-chrome'), 'PATH candidates are recorded');
  assert.ok(resolved.tried.length >= PATH_CANDIDATES.length, 'every candidate is recorded');
});

test('defaultChromeCandidates describes each platform', () => {
  const linux = defaultChromeCandidates({}, LINUX);
  assert.ok(linux.includes('/usr/bin/google-chrome') && linux.includes('/usr/bin/chromium'));
  const mac = defaultChromeCandidates({ HOME: '/Users/r' }, 'darwin');
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(mac.includes(path.posix.join('/Users/r', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')));
  assert.deepEqual(defaultChromeCandidates({ PROGRAMFILES: '' }, 'win32'), []);
});

test('isExecutableFile answers for real files', () => {
  assert.equal(isExecutableFile(process.execPath), true, 'the node binary is executable');
  assert.equal(isExecutableFile('/no/such/file'), false);
});

// The hardcoded macOS path is what made every non-macOS install fail; the
// launcher must resolve rather than assume, and it must be able to attach.
test('the launcher resolves its browser and can attach instead of spawning', async () => {
  const source = await readFile(new URL('../service/browser.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ cdpSocketUrl, cdpVersionUrl, readBrowserSettings/, 'the launcher reads the settings');
  assert.match(source, /const settings = readBrowserSettings\(\)/, 'settings are read at launch');
  assert.match(source, /resolveChromeExecutable\(\{/, 'the executable is resolved');
  assert.match(source, /await this\.spawnBrowser\(url, executable\)/, 'a resolution feeds the spawn');
  assert.match(source, /await this\.attachBrowser\(settings, url\)/, 'an endpoint feeds the attach');
  assert.doesNotMatch(source, /\/Applications\/Google Chrome/, 'no hardcoded macOS path remains');
});
