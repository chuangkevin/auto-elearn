import type { Session } from "electron";
import { enterReadingSession, heartbeat as sendHeartbeat } from "../http/elearn";
import { extractTicket } from "./reader";
import type { Tracked } from "../course/types";

export type ProgressStage = "open" | "tick" | "done" | "error";

export interface PollData {
  isReadDones: number;
  isExamDones: number;
  isSurveyDones: number;
  passPercent?: number;
}

export interface HeartbeatOptions {
  parallel: number;
  intervalMs: number;
  jitterMs: number;
  /** Safety cap: abort one course if it runs this many seconds beyond required. */
  graceSec: number;
  /** Called on lifecycle events. Non-blocking (fire-and-forget). */
  onProgress?: (cid: string, stage: ProgressStage, extra?: Record<string, unknown>) => void;
  /** Called each tick so caller can update UI progress. */
  onTick?: (cid: string, pings: number, elapsedSec: number) => void;
  /** Fetch server-side progress for one course. Called every pollIntervalMs. */
  pollFn?: (cid: string) => Promise<PollData | null>;
  /** Called with server data each time pollFn resolves. */
  onPoll?: (cid: string, data: PollData) => void;
  /** How often to call pollFn (ms). Default 30 000. */
  pollIntervalMs?: number;
  /** Abort signal (checked between ticks). */
  signal?: { aborted: boolean };
}

/**
 * Minimal concurrency limiter (avoids pulling p-limit ESM from CJS main).
 */
function createLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((r) => queue.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/** Run heartbeats for a set of courses until each reaches its required seconds. */
export async function runHeartbeatBatch(
  session: Session,
  courses: Tracked[],
  opts: HeartbeatOptions,
): Promise<void> {
  const limit = createLimit(opts.parallel);
  await Promise.all(courses.map((t) => limit(() => driveCourse(session, t, opts))));
}

async function driveCourse(session: Session, t: Tracked, opts: HeartbeatOptions): Promise<void> {
  const { cid } = t.course;
  const ticket = await extractTicket(cid);
  if (!ticket) {
    opts.onProgress?.(cid, "error", { reason: "no_ticket" });
    return;
  }
  // Fire "open" AFTER we have the ticket so the log can name the host we're
  // about to hit. Cross-course comparison of hosts is how we tell which
  // SPOC providers silently drop our heartbeats.
  opts.onProgress?.(cid, "open", { origin: ticket.origin });

  // Critical: announce the reading session to the server. Without this GET the
  // heartbeat POSTs return 200 but aren't credited as study time (閱讀時數 stays
  // at 0). Matches what the original ecpa.js does before its setInterval loop.
  try {
    const enter = await enterReadingSession(session, ticket.pTicket, ticket.encCid, ticket.origin);
    opts.onProgress?.(cid, "tick", {
      enterSession: { status: enter.status, ok: enter.ok },
    });
  } catch (e) {
    opts.onProgress?.(cid, "error", {
      reason: "enter_reading_failed",
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  const needSec = Math.max(0, t.requiredSec - t.readSec);
  const maxSec = needSec + opts.graceSec;
  const startAt = Date.now();
  let pings = 0;
  let failures = 0;
  let serverConfirmed = false;
  let lastPollAt = Date.now();
  const pollInterval = opts.pollIntervalMs ?? 30_000;

  while (!opts.signal?.aborted) {
    const elapsedSec = Math.floor((Date.now() - startAt) / 1000);
    if (elapsedSec >= maxSec) break;

    try {
      const { ok, status, body } = await sendHeartbeat(session, ticket.pTicket, ticket.encCid, ticket.origin);
      if (ok) {
        pings++;
        failures = 0;
        opts.onTick?.(cid, pings, elapsedSec);
        // One-shot surface the FIRST response body so we can see what the
        // server actually says — "OK" / empty / an error JSON. Without this we
        // have no way to tell why 閱讀時數 stays 0 despite 200 OKs.
        if (pings === 1) {
          opts.onProgress?.(cid, "tick", {
            firstResponse: body.slice(0, 300),
            status,
          });
        }
      } else {
        failures++;
        opts.onProgress?.(cid, "error", { status, failures, body: body.slice(0, 300) });
        if (failures >= 5) break;
        await sleep(3000);
      }
    } catch (e) {
      failures++;
      opts.onProgress?.(cid, "error", {
        msg: e instanceof Error ? e.message : String(e),
        failures,
      });
      if (failures >= 5) break;
      await sleep(3000);
    }

    // Server-side progress poll — fires every pollInterval regardless of ping rate
    if (opts.pollFn && Date.now() - lastPollAt >= pollInterval) {
      lastPollAt = Date.now();
      try {
        const data = await opts.pollFn(cid);
        if (data) {
          opts.onPoll?.(cid, data);
          if (data.isReadDones === 1) {
            serverConfirmed = true;
            break;
          }
        }
      } catch {
        // poll errors are non-fatal; continue heartbeat
      }
    }

    // Sleep until next tick (interval ± jitter)
    const jitter = Math.floor((Math.random() * 2 - 1) * opts.jitterMs);
    await sleep(Math.max(1000, opts.intervalMs + jitter));
  }

  opts.onProgress?.(cid, "done", { pings, serverConfirmed });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
