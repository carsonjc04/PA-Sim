import { ArrowRight, BookOpenCheck, ChevronDown, ChevronUp, NotebookPen, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiRequestError, newKey } from "../../api/client";
import { MICRO_SESSION_SIZE, type PublicReviewSession, type ReviewMode, type SubmitReviewResponse } from "../../api/contracts";
import { promptTypeLabels } from "../../domain/remediation/labels";

type View = "loading" | "error" | "start" | "session" | "finished";

const message = (e: unknown) => (e instanceof ApiRequestError ? e.message : "Something went wrong.");
const days = (n: number) => (n <= 0 ? "later today" : n === 1 ? "in 1 day" : `in ${n} days`);

/**
 * Today's review: due items first, an optional five-item session, resume after interruption,
 * and one low-friction rating after the answer is revealed. No streaks, timers or countdowns.
 */
export function TodayReview() {
  const [view, setView] = useState<View>("loading");
  const [error, setError] = useState<string | null>(null);
  const [dueToday, setDueToday] = useState(0);
  const [session, setSession] = useState<PublicReviewSession | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [moreOptions, setMoreOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SubmitReviewResponse | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const shownAt = useRef(0);
  const answerLatency = useRef<number | null>(null);
  // One idempotency key per item, so a retried rating is never counted twice.
  const keys = useRef(new Map<string, string>());
  const promptRef = useRef<HTMLHeadingElement>(null);

  const current = session?.items.find((i) => i.status === "current") ?? null;

  /** Clears per-item UI state; called whenever a different item becomes current. */
  const resetCard = () => {
    setRevealed(false);
    setMoreOptions(false);
  };

  const fetchCurrent = useCallback(
    () =>
      api
        .currentReview()
        .then((res) => {
          setDueToday(res.dueToday);
          setError(null);
          setRevealed(false);
          setMoreOptions(false);
          if (res.session && !res.session.done) {
            setSession(res.session);
            setView("session");
          } else setView("start");
        })
        .catch((e) => {
          setError(message(e));
          setView("error");
        }),
    [],
  );
  useEffect(() => {
    void fetchCurrent();
  }, [fetchCurrent]);
  const load = () => {
    setView("loading");
    void fetchCurrent();
  };

  // Each time a new item is shown: start its latency clock, move focus to it, and log "shown".
  useEffect(() => {
    if (view !== "session" || !session || !current) return;
    shownAt.current = Date.now();
    answerLatency.current = null;
    promptRef.current?.focus();
    void api.reviewEvent(session.id, { type: "shown", cardId: current.cardId }).catch(() => undefined);
    // Keyed on identity only: a new object for the same item must not count as shown again.
  }, [view, session?.id, current?.cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (mode: ReviewMode, restart = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startReview(mode, restart);
      setDueToday(res.dueToday);
      setLast(null);
      resetCard();
      if (res.session && !res.session.done) {
        setSession(res.session);
        setView("session");
      } else {
        setSession(null);
        setView("start");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const reveal = () => {
    if (!session || !current) return;
    answerLatency.current = Date.now() - shownAt.current;
    setRevealed(true);
    setAnnouncement("Answer revealed.");
    void api
      .reviewEvent(session.id, { type: "answered", cardId: current.cardId, latencyMs: answerLatency.current })
      .catch(() => undefined);
  };

  const rate = async (rating: 1 | 2 | 3 | 4) => {
    if (!session || !current || busy) return;
    const keyId = `${session.id}:${current.cardId}`;
    const key = keys.current.get(keyId) ?? newKey();
    keys.current.set(keyId, key);
    setBusy(true);
    setError(null);
    try {
      const res = await api.rateReview(
        current.cardId,
        { sessionId: session.id, promptId: current.prompt.id, rating, latencyMs: answerLatency.current },
        key,
      );
      setLast(res);
      setAnnouncement(`Saved. Next review ${days(res.nextDueInDays)}.`);
      const position = res.session.position;
      resetCard();
      setSession({
        ...session,
        position,
        done: res.session.done,
        items: session.items.map((item, i) => ({
          ...item,
          status: i < position ? "done" : i === position ? "current" : "upcoming",
        })),
      });
      if (res.session.done) {
        setView("finished");
        api
          .reviewSummary()
          .then((s) => setDueToday(s.dueToday))
          .catch(() => undefined);
      }
    } catch (e) {
      // Another tab moved on, or an earlier rating for this item was saved after all: reload the saved session instead of guessing.
      if (e instanceof ApiRequestError && (e.code === "review_out_of_order" || e.code === "idempotency_conflict")) load();
      else setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (view === "loading") return <div className="loading">Loading your review...</div>;
  if (view === "error")
    return (
      <div className="empty-state">
        <h1>Review is unavailable</h1>
        <p className="lede">{error}</p>
        <button type="button" className="button button-primary" onClick={load}>
          Try again
        </button>
      </div>
    );

  return (
    <div className="review-shell">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <div className="review-head">
        <p className="eyebrow">TODAY&rsquo;S REVIEW</p>
        <h1>
          Practice what you <em>missed</em>.
        </h1>
        <p className="lede">
          Short retrieval questions built from misses in cases you have submitted. Answer in your
          head first, then reveal.
        </p>
      </div>

      {error && view !== "session" && (
        <div className="review-inline-error" role="alert">
          <p>{error}</p>
        </div>
      )}

      {view === "start" && (
        <section className="panel review-start">
          {dueToday === 0 ? (
            <>
              <BookOpenCheck size={22} className="review-start-icon" />
              <h2>Nothing due right now</h2>
              <p>
                New items appear after you submit a case with misses. Items you have reviewed come
                back when they are due.
              </p>
              <Link className="button button-primary" to="/cases">
                Browse cases <ArrowRight size={15} />
              </Link>
            </>
          ) : (
            <>
              <h2>
                {dueToday} {dueToday === 1 ? "item" : "items"} ready
              </h2>
              <p>Do a few now or all of them. Progress is saved after every answer.</p>
              <div className="review-start-actions">
                {dueToday > MICRO_SESSION_SIZE && (
                  <button type="button" className="button button-primary" disabled={busy} onClick={() => void start("micro")}>
                    Quick {MICRO_SESSION_SIZE}
                  </button>
                )}
                <button
                  type="button"
                  className={`button ${dueToday > MICRO_SESSION_SIZE ? "button-quiet" : "button-primary"}`}
                  disabled={busy}
                  onClick={() => void start("all")}
                >
                  Review {dueToday > MICRO_SESSION_SIZE ? `all ${dueToday}` : dueToday === 1 ? "it" : `all ${dueToday}`}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {view === "finished" && session && (
        <section className="panel review-start">
          <BookOpenCheck size={22} className="review-start-icon" />
          <h2>Session complete</h2>
          <p>
            You reviewed {session.total} {session.total === 1 ? "item" : "items"}.
            {last ? ` The last one comes back ${days(last.nextDueInDays)}.` : ""}
          </p>
          <div className="review-start-actions">
            {dueToday > 0 && (
              <button type="button" className="button button-primary" disabled={busy} onClick={() => void start("all")}>
                Review {dueToday} more
              </button>
            )}
            <Link className="button button-quiet" to="/dashboard">
              Back to dashboard
            </Link>
          </div>
        </section>
      )}

      {view === "session" && session && current && (
        <>
          <div className="review-progress">
            <span>
              Item {session.position + 1} of {session.total}
            </span>
            <div
              className="bar"
              role="progressbar"
              aria-label="Session progress"
              aria-valuemin={0}
              aria-valuemax={session.total}
              aria-valuenow={session.position}
            >
              <i style={{ width: `${(session.position / session.total) * 100}%` }} />
            </div>
          </div>
          {session.draftContent && (
            <p className="review-plan-note">
              <NotebookPen size={14} /> Draft questions, not yet clinically reviewed.
            </p>
          )}
          <article className="panel review-card" aria-labelledby="review-prompt">
            <div className="review-card-top">
              <span className="tag">{promptTypeLabels[current.prompt.type]}</span>
              <small>{current.knowledgeLabel}</small>
            </div>
            <h2 id="review-prompt" ref={promptRef} tabIndex={-1}>
              {current.prompt.front}
            </h2>
            {current.prompt.choices && (
              <ol className="review-choices" type="A">
                {current.prompt.choices.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
            )}

            {!revealed ? (
              <button type="button" className="button button-primary review-reveal" onClick={reveal}>
                Show answer
              </button>
            ) : (
              <>
                <div className="review-answer">
                  <strong>{current.answer}</strong>
                  <p>{current.explanation}</p>
                </div>
                <div className="review-why">
                  <span>Why this is here</span>
                  <p>{current.reason.text}</p>
                  {current.source && (
                    <Link to={`/results/${current.source.attemptId}#miss-${encodeURIComponent(current.source.rubricItemId)}`}>
                      Open the case debrief <ArrowRight size={13} />
                    </Link>
                  )}
                </div>
                <fieldset className="review-rating" disabled={busy}>
                  <legend>How did you do?</legend>
                  <div className="review-rating-main">
                    <button type="button" className="button rating-missed" onClick={() => void rate(1)}>
                      Missed it
                    </button>
                    <button type="button" className="button rating-got" onClick={() => void rate(3)}>
                      Got it
                    </button>
                  </div>
                  <button
                    type="button"
                    className="review-more"
                    aria-expanded={moreOptions}
                    aria-controls="review-more-options"
                    onClick={() => setMoreOptions((v) => !v)}
                  >
                    More options {moreOptions ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {moreOptions && (
                    <div className="review-rating-more" id="review-more-options">
                      <button type="button" className="button button-quiet" onClick={() => void rate(2)}>
                        Got it, but it was hard
                      </button>
                      <button type="button" className="button button-quiet" onClick={() => void rate(4)}>
                        Easy
                      </button>
                    </div>
                  )}
                </fieldset>
                {error && (
                  <div className="review-inline-error" role="alert">
                    <p>{error} Your answer was not saved yet; choose a rating again to retry.</p>
                  </div>
                )}
              </>
            )}
          </article>
          <div className="review-footer">
            <span>Progress is saved after every answer. You can leave and resume later.</span>
            <button type="button" className="text-link" disabled={busy} onClick={() => void start(session.mode, true)}>
              <RotateCcw size={13} /> Start over
            </button>
          </div>
        </>
      )}
    </div>
  );
}
