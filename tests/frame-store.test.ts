import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameStore } from '../service/frame-store.ts';

const jpeg = (tag: string): Buffer => Buffer.from(tag);

test('a first request with after=0 gets the picture at once', async () => {
  const store = new FrameStore();
  assert.equal(store.latest(), null, 'nothing before the first frame');
  const pushed = store.push(jpeg('a'), 1280, 800);
  assert.deepEqual(
    { seq: pushed.seq, width: pushed.width, height: pushed.height },
    { seq: 1, width: 1280, height: 800 },
    'the sequence starts at 1 and the size is the coordinate space',
  );
  assert.equal((await store.next(0, 1000))?.seq, 1);
});

test('a waiter is woken by the next frame, never by the current one', async () => {
  const store = new FrameStore();
  store.push(jpeg('a'), 10, 10);
  const waiting = store.next(1, 5_000);
  store.push(jpeg('b'), 10, 10);
  assert.equal((await waiting)?.seq, 2);
});

test('a viewer already holding the newest frame times out to null', async () => {
  const store = new FrameStore();
  store.push(jpeg('a'), 10, 10);
  assert.equal(await store.next(1, 20), null, 'nothing newer arrives in the window');
  assert.equal(await store.next(1, 0), null, 'a zero wait resolves at once instead of registering');
  assert.equal((await store.next(0, 0))?.seq, 1, 'after=0 is "the picture, now"');
});

test('only the newest frame is kept: a slow viewer skips, never queues', async () => {
  const store = new FrameStore();
  store.push(jpeg('a'), 10, 10);
  store.push(jpeg('b'), 10, 10);
  assert.equal(store.latest()?.seq, 2);
  assert.equal((await store.next(0, 0))?.seq, 2);
});

test('close releases waiters and drops the picture, but never rewinds the sequence', async () => {
  const store = new FrameStore();
  store.push(jpeg('a'), 10, 10);
  const waiting = store.next(1, 5_000);
  store.close();
  assert.equal(await waiting, null, 'a waiter must not hang on a browser that is gone');
  assert.equal(store.latest(), null);
  const next = store.push(jpeg('b'), 10, 10);
  assert.equal(next.seq, 2, 'a viewer that drew frame 1 still gets something newer after a relaunch');
  assert.equal((await store.next(1, 0))?.seq, 2);
});

test('one push wakes every waiter that wants it', async () => {
  const store = new FrameStore();
  const first = store.next(0, 1000);
  const second = store.next(0, 1000);
  store.push(jpeg('a'), 10, 10);
  assert.deepEqual([(await first)?.seq, (await second)?.seq], [1, 1]);
});
