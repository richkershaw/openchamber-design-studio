// The single Browser instance the service owns, and who is driving it.
//
// The live view is a real Chrome window (or an attached browser), opened through
// main.ts's /open route. When the extension declares `service.surface`, the host
// also draws that window in the rail panel: it pulls frames from
// service/surface-routes.ts and pushes the viewer's input back. Two pieces of
// state belong to that arrangement and live here, beside the browser they are
// about:
//
//  · the control notice the host posts on every change, so verification and the
//    agent's own browser actions can stand down while a person is in control;
//  · the agent-activity clock, which makes each frame say "an agent is driving"
//    for a while after the host's `browser.*` actions, so the panel can show it.
import { SURFACE_AGENT_HOLD_MS, type SurfaceControlNotice, type SurfaceController } from '@openchamber/sdk';

import { Browser } from './browser.ts';

let browser: Browser | null = null;

/**
 * The single Browser instance, started on demand.
 *
 * With a URL this launches (or reuses) the live window at it. WITHOUT a URL it
 * returns the handle and deliberately does NOT launch: callers that then
 * navigate (verify.ts, browser-control.ts) supply the real URL and the window
 * is created lazily at it. That is what keeps an `about:blank` placeholder out
 * of the launch path — a blank launch would give a normal tabbed window.
 */
export async function ensureBrowser(url?: string): Promise<Browser> {
  if (!browser) browser = new Browser();
  if (url !== undefined) await browser.start(url);
  return browser;
}

/** The Browser instance if one has started, else null. */
export function getBrowser(): Browser | null {
  return browser;
}

/**
 * Stop the service's link to the live window.
 *
 * A window we launched is the user's, not the service's: it is spawned detached
 * and is deliberately NOT killed here, so a host stop/restart leaves the page on
 * screen. A restarted service cannot re-attach (it does not persist the
 * throwaway profile or the random debugging port), so it reports
 * `windowOpen:false` and the next `/open` launches a fresh window. Set
 * `DS_KILL_WINDOW_ON_STOP=1` to kill it anyway (tests do, to avoid leaking a
 * window). An attached browser is never ours to kill at all.
 */
export async function stopBrowser(): Promise<void> {
  if (!browser) return;
  const current = browser;
  browser = null;
  controlNotice = null;
  agentActiveAt = 0;
  await current.stop({ kill: process.env.DS_KILL_WINDOW_ON_STOP === '1' });
}

// ---- who is driving ----

/** The last control notice the host posted, or null before the first one. */
let controlNotice: SurfaceControlNotice | null = null;
/** When the agent last drove the browser, for the `x-surface-agent-active` flag. */
let agentActiveAt = 0;

/**
 * Record a control notice (`POST /surface/control`). The host owns control: it
 * says `agent` while its own agent actions hold the surface, `user` with the
 * viewer id while a person does, and `none` when the surface is idle.
 */
export function setController(notice: SurfaceControlNotice): void {
  controlNotice = notice;
}

/**
 * Who holds the surface right now. Verification reads this to stand down while a
 * person is in control (`getController() === 'user'`), and the agent's browser
 * actions are refused by the host before they reach us at all.
 */
export function getController(): SurfaceController {
  return controlNotice?.controller ?? 'none';
}

/** The viewer holding control, when the last notice named one. */
export function controlViewer(): string | null {
  return controlNotice?.controller === 'user' ? controlNotice.viewer ?? null : null;
}

/** The agent just drove the browser: say so on the frames for the hold window. */
export function noteAgentActivity(): void {
  agentActiveAt = Date.now();
}

/** True while an agent action is recent enough to show on the surface. */
export function agentActive(): boolean {
  return agentActiveAt !== 0 && Date.now() - agentActiveAt < SURFACE_AGENT_HOLD_MS;
}
