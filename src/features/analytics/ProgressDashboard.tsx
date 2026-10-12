import { ArrowRight, Compass, ListChecks, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { PublicAnalyticsDashboard } from "../../api/contracts";
import type { AreaResult, EvidenceRef, Priority, RateResult, Sufficiency } from "../../domain/analytics/types";
import { errorTypeLabels } from "../../domain/remediation/labels";

const SUFFICIENCY: Record<Sufficiency, string> = {
  none: "No data yet",
  insufficient: "Not enough evidence yet",
  limited: "Limited evidence",
  adequate: "Adequate evidence",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** Week keys are calendar dates in the student's zone; format them without shifting through the browser zone. */
const weekLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

function SufficiencyTag({ value }: { value: Sufficiency }) {
  return <span className={`progress-tier progress-tier--${value}`}>{SUFFICIENCY[value]}</span>;
}

/** A rate, or plainly why there is no rate. Never a bare percentage without its sample. */
function Rate({ rate, unit = "attempt" }: { rate: RateResult; unit?: string }) {
  if (rate.value === null || !rate.interval) {
    return (
      <span className="progress-rate">
        <span className="muted">{rate.n ? `${rate.successes} of ${plural(rate.n, unit)}` : "—"}</span>
        <SufficiencyTag value={rate.sufficiency} />
      </span>
    );
  }
  return (
    <span className="progress-rate">
      <strong>{pct(rate.value)}</strong>
      <span className="muted">
        {rate.successes} of {plural(rate.n, unit)} · likely {pct(rate.interval.low)}–{pct(rate.interval.high)}
      </span>
      <SufficiencyTag value={rate.sufficiency} />
    </span>
  );
}

/** The stored records behind a statement, linked to the debriefs they came from. */
function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  if (!evidence.length) return null;
  const attempts = new Map<string, string>();
  for (const e of evidence) if (e.attemptId && (!attempts.has(e.attemptId) || e.source === "attempt")) attempts.set(e.attemptId, e.at);
  const misses = evidence.filter((e) => e.source === "remediation_evidence").length;
  const reviews = evidence.filter((e) => e.source === "learning_event").length;
  const parts = [attempts.size && plural(attempts.size, "attempt"), misses && plural(misses, "recorded miss", "recorded misses"), reviews && plural(reviews, "review")].filter(Boolean);
  return (
    <details className="progress-evidence">
      <summary>Show the records ({parts.join(", ")})</summary>
      <ul>
        {[...attempts].sort(([, a], [, b]) => b.localeCompare(a)).map(([id, at]) => (
          <li key={id}>
            <Link className="text-link" to={`/results/${encodeURIComponent(id)}`}>
              Debrief from {shortDate(at)}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

function basisText(p: Priority) {
  if (p.kind === "coverage-gap") return "Based on the blueprint and the published cases";
  if (p.kind === "due-retrieval") return `Based on ${plural(p.basis.n, "card")} due today`;
  return `Based on ${plural(p.basis.n, "attempt")}${p.basis.sufficiency ? ` · ${SUFFICIENCY[p.basis.sufficiency]}` : ""}`;
}

function Priorities({ items }: { items: Priority[] }) {
  return (
    <section className="panel progress-section" aria-labelledby="progress-priorities">
      <div className="section-heading">
        <div>
          <p className="eyebrow">NEXT STEPS</p>
          <h2 id="progress-priorities">What to work on next</h2>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="muted">Nothing stands out right now. Pick any case to keep practicing.</p>
      ) : (
        <ol className="progress-priorities">
          {items.map((p, i) => (
            <li key={`${p.kind}-${i}`} className={`progress-priority progress-priority--${p.kind}`}>
              <span className="progress-rank" aria-hidden="true">{i + 1}</span>
              <div>
                <h3>{p.title}</h3>
                <p>{p.why}</p>
                <p className="progress-basis">{basisText(p)}</p>
                <EvidenceList evidence={p.evidence} />
              </div>
              <Link className="button button-small" to={p.nextAction.href}>
                {p.nextAction.label} <ArrowRight size={15} />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AreaTable({ caption, rows, emptyNote }: { caption: string; rows: AreaResult[]; emptyNote?: string }) {
  return (
    <div className="progress-table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="progress-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Blueprint weight</th>
            <th scope="col">Practice</th>
            <th scope="col">Attempts without a miss here</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <th scope="row">{a.label}</th>
              <td>{a.weightPct}%</td>
              <td>{a.exposure.attempts ? `${plural(a.exposure.attempts, "attempt")}, ${plural(a.exposure.distinctCases, "case")}` : emptyNote ?? "None yet"}</td>
              <td>{a.exposure.attempts ? <Rate rate={a.proficiency} /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProgressView({ data }: { data: PublicAnalyticsDashboard }) {
  const content = data.areas.filter((a) => a.kind === "content" && a.exposure.attempts > 0);
  const tasks = data.areas.filter((a) => a.kind === "task");
  const gaps = data.coverage.categories.filter((c) => c.status === "not-attempted");
  const unauthored = data.coverage.categories.filter((c) => c.status === "not-authored");
  const openCritical = data.criticalSafety.filter((c) => !c.resolved);
  const due = data.dueRetrieval;
  const d = data.decision;
  const hasAttempts = data.totals.analyzedAttempts > 0;

  return (
    <div className="progress">
      <Priorities items={data.priorities} />

      <div className="progress-grid">
        <section className="panel progress-section" aria-labelledby="progress-due">
          <h2 id="progress-due">
            <ListChecks size={18} aria-hidden="true" /> Due retrieval
          </h2>
          {due.dueToday > 0 ? (
            <>
              <p className="progress-big">{plural(due.dueToday, "card")} due today</p>
              <p className="muted">{due.overdue ? `${due.overdue} of them were due before today.` : "All of them came due today."}</p>
              <Link className="text-link" to="/review">
                Start review <ArrowRight size={15} />
              </Link>
            </>
          ) : (
            <p className="muted">Nothing is due. Misses from submitted cases become short review questions here.</p>
          )}
          <p className="progress-sub">
            Recall on cards you had seen before: <Rate rate={data.retention.recall} unit="review" />
          </p>
          {data.retention.expectedRecall !== null && data.retention.recall.value !== null && (
            <p className="muted progress-note">
              The scheduler expected about {pct(data.retention.expectedRecall)} recall on those reviews.
            </p>
          )}
        </section>

        <section className="panel progress-section" aria-labelledby="progress-coverage">
          <h2 id="progress-coverage">
            <Compass size={18} aria-hidden="true" /> {data.blueprint.label} blueprint coverage
          </h2>
          <p className="muted">
            Share of blueprint weight: {data.coverage.weightByStatus.attempted}% attempted, {data.coverage.weightByStatus["not-attempted"]}% has a case you have not tried,{" "}
            {data.coverage.weightByStatus["not-authored"]}% has no case yet. This is about the cases you have practiced, not how ready you are.
          </p>
          {gaps.length > 0 && (
            <>
              <h3>Not yet attempted</h3>
              <ul className="progress-list">
                {gaps.map((c) => (
                  <li key={c.id}>
                    <span>{c.label}</span>
                    <span className="muted">{c.weightPct}%</span>
                    <Link className="text-link" to={`/encounter/${encodeURIComponent(c.authoredCaseIds[0])}`}>
                      Try a case
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          {unauthored.length > 0 && (
            <p className="muted progress-note">No case is written yet for: {unauthored.map((c) => c.label).join(", ")}.</p>
          )}
        </section>
      </div>

      <section className="panel progress-section" aria-labelledby="progress-areas">
        <h2 id="progress-areas">By area</h2>
        <p className="muted">
          Practice counts how much you have done. The result is shown only once there are at least 3 attempts across 2 cases; a single good case is not
          a strength yet. The range is an 80% interval.
        </p>
        {content.length ? (
          <AreaTable caption="Body systems you have practiced" rows={content} />
        ) : (
          <p className="muted">No body system practiced yet.</p>
        )}
        <AreaTable caption="Tasks" rows={tasks} emptyNote="Not measured by cases yet" />
      </section>

      {hasAttempts && (
        <section className="panel progress-section" aria-labelledby="progress-patterns">
          <h2 id="progress-patterns">Patterns in your misses</h2>
          {openCritical.length > 0 && (
            <div className="progress-alert" role="note">
              <ShieldAlert size={18} aria-hidden="true" />
              <div>
                <strong>Safety items not yet avoided on a retry</strong>
                <ul>
                  {openCritical.map((c) => (
                    <li key={`${c.scenarioId}-${c.rubricItemId}`}>
                      {c.label} — {c.scenarioTitle}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {data.errorTypes.length ? (
            <ul className="progress-list">
              {data.errorTypes.map((e) => (
                <li key={e.errorType}>
                  <span>{errorTypeLabels[e.errorType]}</span>
                  <span className="muted">
                    {plural(e.occurrences, "time")} in {plural(e.attempts, "attempt")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No misses recorded in your submitted attempts.</p>
          )}
          <h3>Decisions</h3>
          <p className="muted">
            {d.firstDiagnosis.medianMs !== null && d.finalDiagnosis.medianMs !== null
              ? `Typically ${minutes(d.firstDiagnosis.medianMs)} from opening a case to your first diagnosis, and ${minutes(d.finalDiagnosis.medianMs)} to the one you kept (over ${plural(d.attempts, "attempt")}). `
              : `Typical timing appears after a few more attempts (${plural(d.attempts, "attempt")} so far). `}
            You changed your primary diagnosis in {d.attemptsWithDiagnosisChange} of {plural(d.attempts, "attempt")}
            {d.confidenceChanges ? ` and changed your confidence ${plural(d.confidenceChanges, "time")}` : ""}.
          </p>
        </section>
      )}

      {data.trend.buckets.length > 0 && (
        <section className="panel progress-section" aria-labelledby="progress-trend">
          <h2 id="progress-trend">Change over time</h2>
          <div className="progress-table-wrap" tabIndex={0} role="region" aria-label="Change over time by week">
            <table className="progress-table">
              <caption>By study week, in your time zone</caption>
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col">Cases</th>
                  <th scope="col">Task checks without a miss</th>
                  <th scope="col">Review recall</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.buckets.map((b) => (
                  <tr key={b.weekStart}>
                    <th scope="row">{weekLabel(b.weekStart)}</th>
                    <td>
                      {plural(b.attempts, "attempt")}, {plural(b.distinctCases, "case")}
                      {b.criticalMisses ? <span className="progress-flag"> · {plural(b.criticalMisses, "safety miss", "safety misses")}</span> : null}
                    </td>
                    <td>{b.attempts ? <Rate rate={b.taskClean} unit="check" /> : "—"}</td>
                    <td>{b.recall.n ? <Rate rate={b.recall} unit="review" /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="progress-limits" aria-labelledby="progress-limits">
        <h2 id="progress-limits">What this page is not</h2>
        <p>{data.readiness.reason}</p>
        <p>
          There are no comparisons with other students or national figures. The thresholds and ranking rules are study heuristics that have not been
          validated. Everything here comes from your own submitted attempts and reviews
          {data.totals.notYetAnalyzed ? `; ${plural(data.totals.notYetAnalyzed, "attempt is", "attempts are")} still being analyzed and are not counted yet` : ""}.
        </p>
        <p className="muted">Definitions: {data.analyticsVersion}</p>
      </section>
    </div>
  );
}

export function ProgressDashboard({ user }: { user: string | null }) {
  const [data, setData] = useState<PublicAnalyticsDashboard | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api
      .analyticsDashboard()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [user, attempt]);

  if (error)
    return (
      <section className="panel progress-section" role="alert">
        <h2>Progress is unavailable right now</h2>
        <p className="muted">Your practice history below is unaffected.</p>
        <button type="button" className="button button-quiet" onClick={() => {
            setError(false);
            setAttempt((n) => n + 1);
          }}>
          Try again
        </button>
      </section>
    );
  if (!data)
    return (
      <p className="muted progress-loading" role="status">
        Loading your progress…
      </p>
    );
  return <ProgressView data={data} />;
}
