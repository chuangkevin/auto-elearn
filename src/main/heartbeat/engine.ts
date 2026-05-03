import type { Session } from "electron";
import { enterReadingSession, finishReadingSession, getServerTime, heartbeat as sendHeartbeat, startReadingSession } from "../http/elearn";
import { executeScormFinish, extractTicket, type TicketInfo } from "./reader";
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
  /** Fetch /info/{cid} detail page (real reading time from server) for the
   *  course. Called every detailPollIntervalMs to keep the local card in sync
   *  with what's actually on the elearn page. */
  detailPollFn?: (cid: string) => Promise<{ readSec: number | null } | null>;
  /** Called when detailPollFn returns; lets caller update card.readSec from
   *  the authoritative server number (not just local elapsed). */
  onDetailPoll?: (cid: string, data: { readSec: number | null }) => void;
  /** How often to fetch detail page (ms). Default 120 000 (2 min). */
  detailPollIntervalMs?: number;
  /** Fired ONCE per course as soon as cumulative reading credit reaches half
   *  of requiredSec. Lets the caller fire 測驗+問卷 in parallel with the
   *  remaining reading — exam_start.php and survey endpoints don't gate on
   *  full reading credit, so we can save ~half the wall-clock time. The
   *  heartbeat keeps ticking afterwards until reading is fully credited. */
  onHalfway?: (cid: string) => void;
  /** v0.8.1：當 heartbeat 連續失敗達 reauthThreshold 時呼叫 — caller 應該重新登入
   *  partition 的 SSO，並重抽一張 ticket 回傳。回 null 代表救不回來，loop 走原本
   *  的 5-failure-break 路徑。Hahow 並行登入上限 / SSO session timeout 都會把
   *  reading session 從 server 端清掉，沒重抽 actid 的話心跳全部 noop（server
   *  回 success 但完全不算時數），這就是使用者「課程時數歸零」的根因之一。 */
  reauthFn?: (cid: string) => Promise<TicketInfo | null>;
  /** v0.8.1：連續 N 次 heartbeat 失敗後嘗試 reauth。Default 3 — 比 break 早 2 次，
   *  讓我們有機會在 loop 死掉前救回來。 */
  reauthThreshold?: number;
  /** Abort signal (checked between ticks). */
  signal?: { aborted: boolean };
  /** v0.8.3：暫停 signal。每 tick 開始前讀；paused=true 時 sleep 500ms 重檢，直到
   *  false 或 abort。bt 跟 actid 維持不動，恢復後接著打 — server 看到的 elapsedSec
   *  變大，照常 credit 一個 period。長時間暫停 server 端 reading session 可能會被
   *  GC 掉，那時 heartbeat 會失敗 → reauthFn 接手重抽 ticket，這條路徑走得通。 */
  pauseSignal?: { paused: boolean };
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
  const { cid, caption } = t.course;
  // Retry ticket extraction up to 3 times. The 多重視窗 guard on elearn
  // sometimes shunts a course to warning.php even with the global semaphore;
  // a short backoff lets the previous slot's window fully tear down before
  // we try again. Pass caption so the actid picker can fuzzy-match against
  // the SCORM tree's lesson text — courses sharing one player (e.g. 人權搜
  // 查客 series) need this to grab THEIR lesson rather than a sibling's.
  let ticket: Awaited<ReturnType<typeof extractTicket>> = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    ticket = await extractTicket(cid, 30_000, caption, session);
    if (ticket) break;
    if (attempt < 3) await sleep(5000 + Math.random() * 3000);
  }
  if (!ticket) {
    opts.onProgress?.(cid, "error", { reason: "no_ticket" });
    return;
  }
  // Fire "open" AFTER we have the ticket so the log can name the host we're
  // about to hit. Cross-course comparison of hosts is how we tell which
  // SPOC providers silently drop our heartbeats. Pass actid + encCid so
  // the UI can show "actid: I_SCO_..." per course — collisions across cids
  // (= shared SCORM tree) are immediately visible.
  opts.onProgress?.(cid, "open", {
    origin: ticket.origin,
    actid: ticket.actid,
    encCid: ticket.encCid,
  });

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
  let lastDetailPollAt = Date.now();
  const pollInterval = opts.pollIntervalMs ?? 30_000;
  const detailPollInterval = opts.detailPollIntervalMs ?? 120_000;

  // Halfway gate — fire the caller's hook the first time cumulative credit
  // (server-confirmed readSec at start + locally-elapsed seconds since) reaches
  // requiredSec / 2. Caller uses this to start 測驗+問卷 in parallel with the
  // remaining reading. Once-only; the loop keeps running afterwards.
  const halfwaySec = t.requiredSec / 2;
  let halfwayFired = false;
  const fireHalfway = () => {
    if (halfwayFired) return;
    halfwayFired = true;
    try { opts.onHalfway?.(cid); } catch { /* caller mistakes shouldn't kill heartbeat */ }
  };
  // Course already past 50% credit before we even tick — fire immediately so
  // the chain doesn't wait one full interval.
  if (t.readSec >= halfwaySec) fireHalfway();

  // CRITICAL: the server validates elapsed >= period before crediting reading time.
  // Sleep one full interval BEFORE the first heartbeat so the server sees the
  // correct time delta (bt → current_server_time ≈ period).
  {
    const jitter = Math.floor((Math.random() * 2 - 1) * opts.jitterMs);
    await sleep(Math.max(1000, opts.intervalMs + jitter));
  }

  while (!opts.signal?.aborted) {
    // v0.8.3：暫停 gate — 跑下一個 heartbeat 前看看使用者按沒按暫停
    while (opts.pauseSignal?.paused && !opts.signal?.aborted) {
      await sleep(500);
    }
    if (opts.signal?.aborted) break;

    const elapsedSec = Math.floor((Date.now() - startAt) / 1000);
    if (elapsedSec >= maxSec) break;

    try {
      // bt anchors at the original setReading(start) timestamp; we keep it
      // fixed (server-driven via response.timediff) so each end's
      // elapsed = (server_now - bt) >= period and server credits the period.
      // Re-issuing setReading(start) here (a previous attempt) would reset
      // bt to "now", making every subsequent end fail the elapsed >= period
      // check and crediting 0 seconds — server returns success but data
      // never advances. Don't do that.
      const { ok, status, body, timediff } = await sendHeartbeat(
        session, ticket.pTicket, ticket.encCid, ticket.origin, opts.intervalMs, bt, ticket.actid,
      );
      if (ok) {
        bt = timediff;
        pings++;
        failures = 0;
        opts.onTick?.(cid, pings, elapsedSec);
        // Halfway check after each successful tick: cumulative credit ≈
        // initial t.readSec (server-confirmed at pipeline start) + elapsedSec
        // (locally ticked since). Once that crosses requiredSec/2, fire the
        // halfway hook so caller can start 測驗+問卷 in parallel.
        if (!halfwayFired && t.readSec + elapsedSec >= halfwaySec) {
          fireHalfway();
        }
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
        const reauthThreshold = opts.reauthThreshold ?? 3;
        if (failures >= reauthThreshold && opts.reauthFn) {
          const newTicket = await opts.reauthFn(cid).catch(() => null);
          if (newTicket) {
            opts.onProgress?.(cid, "tick", { reauthOk: true, oldActid: ticket.actid, newActid: newTicket.actid });
            ticket = newTicket;
            try { bt = await getServerTime(session, ticket.origin); } catch { bt = "0"; }
            try {
              const r = await startReadingSession(session, ticket.pTicket, ticket.encCid, ticket.origin, ticket.actid, bt);
              bt = r.timediff;
            } catch { /* fall through; loop will retry */ }
            failures = 0;
            continue;
          }
        }
        if (failures >= 5) break;
        await sleep(3000);
      }
    } catch (e) {
      failures++;
      opts.onProgress?.(cid, "error", {
        msg: e instanceof Error ? e.message : String(e),
        failures,
      });
      const reauthThreshold = opts.reauthThreshold ?? 3;
      if (failures >= reauthThreshold && opts.reauthFn) {
        const newTicket = await opts.reauthFn(cid).catch(() => null);
        if (newTicket) {
          opts.onProgress?.(cid, "tick", { reauthOk: true, oldActid: ticket.actid, newActid: newTicket.actid });
          ticket = newTicket;
          try { bt = await getServerTime(session, ticket.origin); } catch { bt = "0"; }
          try {
            const r = await startReadingSession(session, ticket.pTicket, ticket.encCid, ticket.origin, ticket.actid, bt);
            bt = r.timediff;
          } catch { /* fall through */ }
          failures = 0;
          continue;
        }
      }
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

    // Detail-page poll — pulls authoritative 閱讀時數 (real server credit) so
    // the local UI matches what the user sees on /info/{cid}. Slower cadence
    // than the listing poll because each call is a full page fetch + parse.
    if (opts.detailPollFn && Date.now() - lastDetailPollAt >= detailPollInterval) {
      lastDetailPollAt = Date.now();
      try {
        const detail = await opts.detailPollFn(cid);
        if (detail) {
          opts.onDetailPoll?.(cid, detail);
          // Authoritative server credit may already be past halfway even
          // when local elapsedSec hasn't caught up yet (e.g. course had
          // partial credit from a previous run that t.readSec didn't fully
          // capture). Use it to advance the halfway gate too.
          if (!halfwayFired && detail.readSec !== null && detail.readSec >= halfwaySec) {
            fireHalfway();
          }
          // Once server has credited the full required time, every extra
          // ping is wasted and the chain wants to advance to exam ASAP.
          // Earlier code only broke on isReadDones=1 (永遠不會來) or
          // caption=已通過 (also fires only after exam+survey), so reading
          // would tick well past the threshold and then sit through the
          // 3-min post-finish wait too.
          if (detail.readSec !== null && detail.readSec >= t.requiredSec) {
            serverConfirmed = true;
            opts.onProgress?.(cid, "tick", {
              readingDoneEarly: true,
              readSec: detail.readSec,
              requiredSec: t.requiredSec,
            });
            break;
          }
        }
      } catch {
        // non-fatal — local card just stays at last known value
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

  // Poll briefly for isReadDones=1 / detail.readSec >= required after the
  // finish signal. Earlier this was 3 minutes (180_000ms), but isReadDones
  // is hardcoded to 0 server-side and won't flip until the entire course
  // passes — so we'd burn 3 full minutes per course on a flag that never
  // fires. Cut to 30s with detail-poll fallback so we exit fast once
  // reading time is confirmed credited.
  if (!serverConfirmed && (opts.pollFn || opts.detailPollFn)) {
    const pollDeadline = Date.now() + 30_000;
    while (!serverConfirmed && Date.now() < pollDeadline && !opts.signal?.aborted) {
      await sleep(10_000);
      try {
        if (opts.pollFn) {
          const pollResult = await opts.pollFn(cid);
          if (pollResult) {
            opts.onPoll?.(cid, pollResult);
            if (pollResult.isReadDones === 1) serverConfirmed = true;
          }
        }
        if (!serverConfirmed && opts.detailPollFn) {
          const detail = await opts.detailPollFn(cid);
          if (detail) {
            opts.onDetailPoll?.(cid, detail);
            if (detail.readSec !== null && detail.readSec >= t.requiredSec) {
              serverConfirmed = true;
            }
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  // Step 4: SCORM JS finish — open a fresh reader window, wait for the SCORM
  // player to init, then fire LMSSetValue(lesson_status=completed)+LMSFinish.
  // Only needed when the HTTP finish didn't already confirm completion.
  if (!serverConfirmed) {
    try {
      const scormDone = await executeScormFinish(cid, 45_000, session);
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
