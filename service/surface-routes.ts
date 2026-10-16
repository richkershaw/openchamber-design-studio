// The shared surface's HTTP side: what the host calls on this service while a
// viewer is attached to the extension's rail panel.
//
// The host owns the timing (see `@openchamber/sdk` service-surface): it holds one
// frame request open per viewer, posts that viewer's input back, and tells us on
// every control change. Two facts shape everything here:
//
//  · The frame route answers 200 with a picture, or 204 with nothing. Any other
//    status ENDS the host's session outright, so a browser that cannot produce
//    frames must still answer 204 instead of failing loudly.
//  · The picture's coordinate space is the top-level viewport's CSS pixels, and
//    it is reported in `x-surface-width`/`x-surface-height`. The panel maps its
//    pointer into exactly that space, which is why input arrives ready to
//    dispatch (browser.ts, `input(events, 'viewport')`).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SURFACE_AGENT_ACTIVE_HEADER,
  SURFACE_CLIPBOARD_PATH,
  SURFACE_CONTROL_PATH,
  SURFACE_DIMENSION_MAX,
  SURFACE_FRAME_MAX_BYTES,
  SURFACE_FRAME_PATH,
  SURFACE_FRAME_SEQ_HEADER,
  SURFACE_FRAME_WAIT_MS,
  SURFACE_HEIGHT_HEADER,
  SURFACE_INPUT_PATH,
  SURFACE_RESIZE_PATH,
  SURFACE_SEQ_HEADER,
  SURFACE_WIDTH_HEADER,
  readSurfaceControlNotice,
  readSurfaceInputBatch,
  readSurfaceResizeRequest,
} from '@openchamber/sdk';

import { agentActive, getBrowser, setController } from './surface.ts';

/**
 * How many frames behind the newest picture a viewer's input may be before it is
 * refused as stale. The host keeps one frame in flight per viewer, so a viewer
 * drawing the current picture is normally 0 or 1 behind; several frames behind
 * means the click was aimed at something already replaced.
 */
const STALE_FRAME_TOLERANCE = 2;

/** Ceiling on a request body we will read; the host caps batches at 256 events. */
const BODY_MAX_BYTES = 1_000_000;

const SURFACE_PATHS = new Set([
  SURFACE_FRAME_PATH,
  SURFACE_INPUT_PATH,
  SURFACE_CONTROL_PATH,
  SURFACE_RESIZE_PATH,
  SURFACE_CLIPBOARD_PATH,
]);

/** The surface routes, or false when this request is not one of them. */
export async function handleSurfaceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  if (!SURFACE_PATHS.has(pathname)) return false;

  if (pathname === SURFACE_FRAME_PATH) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    await handleFrame(res, url.searchParams);
    return true;
  }
  if (pathname === SURFACE_CLIPBOARD_PATH) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    await handleClipboard(res);
    return true;
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');

  if (pathname === SURFACE_INPUT_PATH) {
    await handleInput(req, res);
    return true;
  }
  if (pathname === SURFACE_CONTROL_PATH) {
    await handleControl(req, res);
    return true;
  }
  await handleResize(req, res);
  return true;
}

/**
 * The next picture. `after=0` is "the picture, now"; the host then asks for what
 * is newer than the sequence it last drew. Nothing to show is a 204, never an
 * error: a service with no window open must leave the pane blank, not end it.
 */
async function handleFrame(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const after = clampInt(params.get('after'), 0, Number.MAX_SAFE_INTEGER, 0);
  const wait = clampInt(params.get('wait'), 0, SURFACE_FRAME_WAIT_MS, 0);
  const browser = getBrowser();
  const frame = browser ? await browser.surfaceFrame(after, wait) : null;
  if (
    !frame ||
    frame.jpeg.length === 0 ||
    frame.jpeg.length > SURFACE_FRAME_MAX_BYTES ||
    frame.width > SURFACE_DIMENSION_MAX ||
    frame.height > SURFACE_DIMENSION_MAX
  ) {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const headers: Record<string, string | number> = {
    'content-type': 'image/jpeg',
    'content-length': frame.jpeg.length,
    'cache-control': 'no-store',
    [SURFACE_SEQ_HEADER]: frame.seq,
    [SURFACE_WIDTH_HEADER]: frame.width,
    [SURFACE_HEIGHT_HEADER]: frame.height,
  };
  if (agentActive()) headers[SURFACE_AGENT_ACTIVE_HEADER] = '1';
  res.writeHead(200, headers);
  res.end(frame.jpeg);
}

/**
 * The viewer's pointer, keyboard and text, in the picture's coordinate space.
 * Refused with 409 when there is no picture, or when the viewer is drawing an old
 * one — the host reads either as "this input did not land" and tells the viewer.
 */
async function handleInput(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, BODY_MAX_BYTES);
  if (body === null) {
    sendJson(res, 413, { error: 'input body is too large' });
    return;
  }
  const batch = readSurfaceInputBatch(body);
  if (batch === null) {
    sendJson(res, 400, { error: 'input batch is not valid' });
    return;
  }
  const browser = getBrowser();
  const latest = browser?.latestFrame() ?? null;
  if (!browser || !latest) {
    sendJson(res, 409, { error: 'there is no live picture to apply input to' });
    return;
  }
  const drawn = intHeader(req, SURFACE_FRAME_SEQ_HEADER);
  if (drawn > 0 && latest.seq - drawn > STALE_FRAME_TOLERANCE) {
    sendJson(res, 409, { error: 'the picture has moved on' });
    return;
  }
  await browser.input(batch.events, 'viewport');
  sendJson(res, 200, { ok: true });
}

/** Who holds the surface, so verification and the agent can stand down. */
async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, BODY_MAX_BYTES);
  const notice = body === null ? null : readSurfaceControlNotice(body);
  if (notice === null) {
    sendJson(res, 400, { error: 'control notice is not valid' });
    return;
  }
  setController(notice);
  sendJson(res, 200, { ok: true });
}

/**
 * The pane's size is a request, not an instruction: the design viewport is
 * deliberate (it is what the gates judge and what the screenshots show), so this
 * keeps its own size and the pane scales the picture into whatever room it has.
 * The contract's "keep your own" answer is a non-200.
 */
async function handleResize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, BODY_MAX_BYTES);
  const request = body === null ? null : readSurfaceResizeRequest(body);
  if (request === null) {
    sendJson(res, 400, { error: 'resize request is not valid' });
    return;
  }
  sendJson(res, 400, { error: 'the design viewport is fixed; the picture is scaled to the pane' });
}

/**
 * Text the viewer selected inside the surface, for the host to put on their
 * clipboard. It is read live from the page under design (the artifact frame) and
 * from the shell's own chrome as a fallback — most often the viewer pressed
 * Cmd/Ctrl+C with that selection still up.
 *
 * Anything but a 200 means "no text", which the host reports to the viewer. That
 * matters more than it looks: the host writes what we return straight onto their
 * clipboard, so answering 200 with an empty string would silently wipe it.
 */
async function handleClipboard(res: ServerResponse): Promise<void> {
  const browser = getBrowser();
  const text = browser ? await browser.selectionText() : '';
  if (text.trim() === '') {
    sendJson(res, 404, { error: 'nothing is selected in the live view' });
    return;
  }
  sendJson(res, 200, { text });
}

function methodNotAllowed(res: ServerResponse, allow: string): boolean {
  res.writeHead(405, { allow, 'cache-control': 'no-store' });
  res.end();
  return true;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** A bounded integer from a query parameter, with a default when absent/garbage. */
function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const value = Number(raw ?? '');
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** A non-negative integer request header; 0 when absent or unreadable. */
function intHeader(req: IncomingMessage, name: string): number {
  const value = Number(req.headers[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** The whole body, or null past `limit` bytes (the socket is destroyed). */
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
