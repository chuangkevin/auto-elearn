import type { Session } from "electron";
import { enterReadingSession, finishReadingSession, getServerTime, heartbeat as sendHeartbeat, startReadingSession } from "../http/elearn";
import { executeScormFinish, extractTicket } from "./reader";
import type { Tracked } from "../course/types";

export type ProgressStage = "open" | "tick" | "done" | "error";

export interface PollData {
  isReadDones: number;
  isExamDones: number;
  isSurveyDones: number;
  /** Caption from server — "已通過" means reading is credited. More reliable than isReadDones. */
  isReadtimeValidCaption?: string;
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

  // Step 1: re-load the reader page (sets server session state for this ticket)
  try {
    const enter = await enterReadingSession(session, ticket.pTicket, ticket.encCid, ticket.origin);
    opts.onProgress?.(cid, "tick", {
      enterSession: { status: enter.status, ok: enter.ok, body: enter.body.slice(0, 200) },
    });
  } catch (e) {
    opts.onProgress?.(cid, "error", {
      reason: "enter_reading_failed",
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  // Step 2: explicit actype=start POST — manifest.js fires this once (3s after
  // lesson click); without it the server has no open timer record and every
  // actype=end heartbeat returns "success" but credits 0 seconds.
  // bt must be a real server timestamp (not "0") — fetch it before the POST.
  // Capture timediff from the response — it becomes the initial bt for the loop.
  let bt = "0";
  try {
    bt = await getServerTime(session, ticket.origin);
  } catch { /* fallback "0" stays */ }
  try {
    const startRes = await startReadingSession(
      session, ticket.pTicket, ticket.encCid, ticket.origin, ticket.actid, bt,
    );
    bt = startRes.timediff;
    opts.onProgress?.(cid, "tick", {
      startSession: { status: startRes.status, ok: startRes.ok, body: startRes.body.slice(0, 200), timediff: bt },
    });
  } catch (e) {
    opts.onProgress?.(cid, "error", {
      reason: "start_reading_failed",
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

  // CRITICAL: the server validates elapsed >= period before crediting reading time.
  // Sleep one full interval BEFORE the first heartbeat so the server sees the
  // correct time delta (bt → current_server_time ≈ period).
  {
    const jitter = Math.floor((Math.random() * 2 - 1) * opts.jitterMs);
    await sleep(Math.max(1000, opts.intervalMs + jitter));
  }

  while (!opts.signal?.aborted) {
    const elapsedSec = Math.floor((Date.now() - startAt) / 1000);
    if (elapsedSec >= maxSec) break;

    try {
      const { ok, status, body, timediff } = await sendHeartbeat(
        session, ticket.pTicket, ticket.encCid, ticket.origin, opts.intervalMs, bt, ticket.actid,
      );
      if (ok) {
        bt = timediff;
        pings++;
        failures = 0;
        opts.onTick?.(cid, pings, elapsedSec);
        // Log response on first tick and every ~60s so we can verify timediff
        // is advancing (= server is crediting time).
        if (pings === 1 || pings % 12 === 0) {
          opts.onProgress?.(cid, "tick", {
            firstResponse: body.slice(0, 300),
            status,
            timediff: bt,
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
          if (data.isReadDones === 1 || data.isReadtimeValidCaption === "已通過") {
            serverConfirmed = true;
            break;
          }
        }
      } catch {
        // poll errors are non-fatal; continue heartbeat
      }
    }

    // Sleep before NEXT tick — server must see elapsed >= period
    const jitter = Math.floor((Math.random() * 2 - 1) * opts.jitterMs);
    await sleep(Math.max(1000, opts.intervalMs + jitter));
  }

  // Step 3: HTTP finish signal — mirrors actype=finish that the browser fires
  // when the SCORM player calls LMSFinish.  The server uses this to mark
  // isReadDones=1 once accumulated time is satisfied.  Try regardless of
  // serverConfirmed since the poll might have missed the flip.
  try {
    const finishRes = await finishReadingSession(
      session, ticket.pTicket, ticket.encCid, ticket.origin, ticket.actid, bt,
    );
    opts.onProgress?.(cid, "tick", {
      httpFinish: { status: finishRes.status, body: finishRes.body.slice(0, 200) },
    });
  } catch (e) {
    opts.onProgress?.(cid, "error", {
      reason: "http_finish_failed",
      msg: e instanceof Error ? e.message : String(e),
    });
  }

  // Poll for up to 3 minutes (every 15s) waiting for isReadDones=1 after the
  // finish signal — gives the server time to process accumulated reading time.
  if (!serverConfirmed && opts.pollFn) {
    const pollDeadline = Date.now() + 180_000;
    while (!serverConfirmed && Date.now() < pollDeadline && !opts.signal?.aborted) {
      await sleep(15_000);
      try {
        const pollResult = await opts.pollFn(cid);
        if (pollResult) {
          opts.onPoll?.(cid, pollResult);
          if (pollResult.isReadDones === 1) serverConfirmed = true;
        }
      } catch { /* non-fatal */ }
    }
  }

  // Step 4: SCORM JS finish — open a fresh reader window, wait for the SCORM
  // player to init, then fire LMSSetValue(lesson_status=completed)+LMSFinish.
  // Only needed when the HTTP finish didn't already confirm completion.
  if (!serverConfirmed) {
    try {
      const scormDone = await executeScormFinish(cid);
      opts.onProgress?.(cid, "tick", { scormFinish: scormDone });
    } catch (e) {
      opts.onProgress?.(cid, "error", {
        reason: "scorm_finish_failed",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  }

  opts.onProgress?.(cid, "done", { pings, serverConfirmed });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
