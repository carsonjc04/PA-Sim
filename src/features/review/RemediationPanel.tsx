import { CalendarClock, ListChecks, NotebookPen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, ApiRequestError } from "../../api/client";
import type { AttemptRemediation, PublicRemediationItem } from "../../api/contracts";
import { errorTypeLabels } from "../../domain/remediation/labels";

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function stateOf(item: PublicRemediationItem): string {
  if (item.status === "unmapped") return "Review not yet authored for this case";
  if (item.cards.some((c) => c.dueToday)) return "In today's review";
  const next = [...item.cards].sort((a, b) => a.due.localeCompare(b.due))[0];
  return next ? `Scheduled for ${dateLabel(next.due)}` : "In your review queue";
}

/**
 * "Review plan" on the debrief: every graded miss with its traceable remediation state.
 * Each row has an anchor (#miss-<rubric item>) so a review card can jump straight back to it.
 */
export function RemediationPanel({ attemptId }: { attemptId: string }) {
  const [data, setData] = useState<AttemptRemediation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();

  const fetchPlan = useCallback(
    () =>
      api
        .remediation(attemptId)
        .then((plan) => {
          setData(plan);
          setError(null);
        })
        .catch((e) =>
          setError(e instanceof ApiRequestError ? e.message : "The review plan could not be loaded."),
        ),
    [attemptId],
  );
  useEffect(() => {
    void fetchPlan();
  }, [fetchPlan]);
  const retry = () => {
    setError(null);
    void fetchPlan();
  };

  // Jump-back target: scroll to and focus the anchored miss once it exists.
  useEffect(() => {
    if (!data || !location.hash.startsWith("#miss-")) return;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [data, location.hash]);

  const dueToday = data?.items.some((i) => i.cards.some((c) => c.dueToday)) ?? false;

  return (
    <section className="panel review-plan" id="review-plan" aria-labelledby="review-plan-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">REVIEW PLAN</p>
          <h2 id="review-plan-title">Turn misses into practice</h2>
        </div>
        {dueToday && (
          <Link className="button button-small" to="/review">
            <ListChecks size={14} /> Today&rsquo;s review
          </Link>
        )}
      </div>
      {error && (
        <div className="review-inline-error" role="alert">
          <p>{error}</p>
          <button type="button" className="button button-quiet" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {!data && !error && <p className="muted">Loading review plan...</p>}
      {data && data.items.length === 0 && (
        <p className="review-plan-empty">
          No misses were recorded for this encounter, so nothing was added to your review.
        </p>
      )}
      {data && data.items.length > 0 && (
        <>
          {!data.authored && (
            <p className="review-plan-note">
              <NotebookPen size={14} /> Review questions have not been written for this case
              yet. Each miss is still recorded here.
            </p>
          )}
          {data.authored && data.draftContent && (
            <p className="review-plan-note">
              <NotebookPen size={14} /> Review questions for this case are a draft and have not
              been clinically reviewed.
            </p>
          )}
          <ul className="review-plan-list">
            {data.items.map((item) => (
              <li
                key={item.rubricItemId}
                id={`miss-${item.rubricItemId}`}
                tabIndex={-1}
                className={location.hash === `#miss-${item.rubricItemId}` ? "targeted" : undefined}
              >
                <div>
                  <span className="tag">{errorTypeLabels[item.errorType]}</span>
                  <strong>{item.label}</strong>
                  {item.cards.length > 0 && (
                    <small>Reviews: {item.cards.map((c) => c.knowledgeLabel).join(" · ")}</small>
                  )}
                </div>
                <span className={`review-state ${item.status === "unmapped" ? "unmapped" : ""}`}>
                  <CalendarClock size={13} /> {stateOf(item)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
