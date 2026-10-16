// The shared surface's routes, exercised against the real built service with no
// browser in it: what a service must answer when there is nothing to show is the
// part the contract is strict about, and it needs no Chrome to prove.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { SURFACE_FRAME_SEQ_HEADER } from '@openchamber/sdk';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'surface-test-token';

/** Reserve then release an ephemeral port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service exited early: ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('service did not become healthy');
}

const MODIFIERS = { alt: false, ctrl: false, meta: false, shift: false };

test('the surface routes answer the host contract with no browser running', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'service', 'main.js')], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: TOKEN },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };
  const post = (pathname: string, body: string, extra: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', ...extra },
      body,
    });

  try {
    await waitForHealth(port, child);

    // Every route keeps the service's bearer contract.
    assert.equal((await fetch(`${base}/surface/frame`)).status, 401, 'frames need the token too');

    // With no window open there is nothing to show. 204 is the ONLY safe answer:
    // any other status ends the host's surface session outright.
    const bare = await fetch(`${base}/surface/frame?after=0&wait=50`, { headers: auth });
    assert.equal(bare.status, 204);
    assert.equal(await bare.text(), '', '204 carries no body');

    // Input: a bad batch is 400, a good batch with nothing on screen is 409.
    assert.equal((await post('/surface/input', 'not json')).status, 400);
    assert.equal((await post('/surface/input', JSON.stringify({ events: [{ type: 'nope' }] }))).status, 400);
    const batch = { events: [{ type: 'pointer', action: 'down', x: 10, y: 20, button: 0, buttons: 1, modifiers: MODIFIERS }] };
    assert.equal((await post('/surface/input', JSON.stringify(batch), { [SURFACE_FRAME_SEQ_HEADER]: '0' })).status, 409);

    // Control notices are recorded; a malformed one is refused.
    assert.equal((await post('/surface/control', JSON.stringify({ controller: 'user', viewer: 'v1' }))).status, 200);
    assert.equal((await post('/surface/control', JSON.stringify({ controller: 'sometimes' }))).status, 400);
    assert.equal((await post('/surface/control', JSON.stringify({ controller: 'none' }))).status, 200);

    // Resize keeps the design viewport; the pane scales the picture instead.
    assert.equal((await post('/surface/resize', JSON.stringify({ width: 900, height: 600 }))).status, 400);
    assert.equal((await post('/surface/resize', JSON.stringify({ width: 'wide' }))).status, 400);

    // Clipboard reads are not implemented, and a non-200 tells the host to say so
    // rather than overwrite the viewer's clipboard.
    assert.equal((await fetch(`${base}/surface/clipboard`, { headers: auth })).status, 501);

    // Methods are pinned per route.
    const wrong = await post('/surface/frame', '');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET');
    assert.equal((await fetch(`${base}/surface/clipboard`, { method: 'POST', headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/surface/nope`, { headers: auth })).status, 404, 'other surface paths are not ours');
  } finally {
    child.kill('SIGKILL');
  }
});
