import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  BROWSER_CONFIG_REL,
  browserConfigPath,
  cdpSocketUrl,
  cdpVersionUrl,
  parseBrowserSettings,
} from '../service/browser-settings.ts';

const LINUX: NodeJS.Platform = 'linux';
const FILE = path.posix.join('/home/r/.config', BROWSER_CONFIG_REL);

test('no file: no settings and no error', () => {
  assert.deepEqual(parseBrowserSettings(null, FILE), { file: FILE });
});

test('path and cdpEndpoint are read and trimmed', () => {
  const settings = parseBrowserSettings(
    JSON.stringify({ path: '  /usr/bin/chromium  ', cdpEndpoint: ' http://sidecar:9222 ' }),
    FILE,
  );
  assert.deepEqual(settings, { file: FILE, path: '/usr/bin/chromium', cdpEndpoint: 'http://sidecar:9222' });
});

test('unknown keys are ignored, so the file can grow', () => {
  const settings = parseBrowserSettings(JSON.stringify({ headless: true, future: { a: 1 } }), FILE);
  assert.deepEqual(settings, { file: FILE });
});

test('a malformed file is an error naming it', () => {
  const settings = parseBrowserSettings('{ not json', FILE);
  assert.match(settings.error ?? '', /is not valid JSON/);
  assert.match(settings.error ?? '', /browser\.json/);
});

test('a file that is not an object is an error', () => {
  assert.match(parseBrowserSettings('[]', FILE).error ?? '', /must contain a JSON object/);
  assert.match(parseBrowserSettings('"chromium"', FILE).error ?? '', /must contain a JSON object/);
});

test('a "path" that is not a non-empty string is an error', () => {
  assert.match(parseBrowserSettings(JSON.stringify({ path: 7 }), FILE).error ?? '', /"path" that is not a non-empty string/);
  assert.match(parseBrowserSettings(JSON.stringify({ path: '   ' }), FILE).error ?? '', /"path" that is not a non-empty string/);
});

test('a "cdpEndpoint" that is not a dialable URL is an error', () => {
  for (const bad of ['sidecar:9222', '/tmp/chrome.sock', 'ftp://sidecar:9222', 9222]) {
    const settings = parseBrowserSettings(JSON.stringify({ cdpEndpoint: bad }), FILE);
    assert.match(settings.error ?? '', /"cdpEndpoint" that is not an http\(s\) or ws\(s\) URL/, `rejects ${String(bad)}`);
  }
});

test('cdpEndpoint accepts http, https, ws and wss', () => {
  for (const good of ['http://sidecar:9222', 'https://sidecar:9222', 'ws://sidecar:9222/', 'wss://sidecar:9222/devtools/browser/x']) {
    const settings = parseBrowserSettings(JSON.stringify({ cdpEndpoint: good }), FILE);
    assert.equal(settings.error, undefined, `accepts ${good}`);
    assert.equal(settings.cdpEndpoint, good);
  }
});

test('browserConfigPath follows XDG_CONFIG_HOME, then HOME, then %APPDATA%', () => {
  assert.equal(
    browserConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/r' }, LINUX),
    path.posix.join('/xdg', BROWSER_CONFIG_REL),
  );
  assert.equal(browserConfigPath({ HOME: '/home/r' }, LINUX), path.posix.join('/home/r/.config', BROWSER_CONFIG_REL));
  assert.equal(
    browserConfigPath({ APPDATA: 'C:\\Users\\r\\AppData\\Roaming' }, 'win32'),
    path.win32.join('C:\\Users\\r\\AppData\\Roaming', BROWSER_CONFIG_REL),
  );
});

test('cdpVersionUrl asks /json/version for an http endpoint and nothing for a ws one', () => {
  assert.equal(cdpVersionUrl('http://sidecar:9222'), 'http://sidecar:9222/json/version');
  assert.equal(cdpVersionUrl('https://sidecar:9222/cdp'), 'https://sidecar:9222/json/version');
  assert.equal(cdpVersionUrl('ws://sidecar:9222/devtools/browser/abc'), null);
});

test('cdpSocketUrl re-homes the reported websocket onto the configured host', () => {
  // A broker answering with its bind address (nothing can dial 0.0.0.0).
  assert.equal(
    cdpSocketUrl('http://browserless:3000', { webSocketDebuggerUrl: 'ws://0.0.0.0:3000/' }),
    'ws://browserless:3000/',
  );
  // A plain Chromium's own devtools path survives the rewrite.
  assert.equal(
    cdpSocketUrl('http://sidecar:9222', { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
    'ws://sidecar:9222/devtools/browser/abc',
  );
  // An https endpoint means a secure socket, whatever the browser reported.
  assert.equal(
    cdpSocketUrl('https://sidecar:9222', { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
    'wss://sidecar:9222/devtools/browser/abc',
  );
});

test('cdpSocketUrl uses a ws endpoint as given', () => {
  assert.equal(
    cdpSocketUrl('ws://sidecar:9222/devtools/browser/abc', { webSocketDebuggerUrl: 'ws://0.0.0.0:1/x' }),
    'ws://sidecar:9222/devtools/browser/abc',
  );
});

test('cdpSocketUrl refuses a missing or unusable reported websocket', () => {
  assert.equal(cdpSocketUrl('http://sidecar:9222', {}), null);
  assert.equal(cdpSocketUrl('http://sidecar:9222', { webSocketDebuggerUrl: '  ' }), null);
  assert.equal(cdpSocketUrl('http://sidecar:9222', { webSocketDebuggerUrl: 'http://sidecar:9222/' }), null);
  assert.equal(cdpSocketUrl('http://sidecar:9222', { webSocketDebuggerUrl: 7 }), null);
});
