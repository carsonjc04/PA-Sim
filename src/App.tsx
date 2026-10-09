import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronLeft,
  ClipboardList,
  Clock3,
  Lock,
  Mic,
  RotateCcw,
  ShieldAlert,
  Stethoscope,
  X,
} from "lucide-react";
import type { Category } from "./domain/types";
import { phaseOrder } from "./domain/types";
import {
  api,
  ApiRequestError,
  deleteLegacyAttempts,
  getDevUser,
  hasLegacyAttempts,
  setDevUser,
} from "./api/client";
import {
  devUserSchema,
  type AttemptSummary,
  type AuthStatus,
  type PublicAttempt,
  type PublicScenario,
  type ToolName,
} from "./api/contracts";
import { VoicePanel } from "./features/encounter/VoicePanel";

const categories: { id: Category; label: string }[] = [
  { id: "history", label: "History taking" },
  { id: "exam", label: "Physical examination" },
  { id: "diagnostics", label: "Diagnostics & reasoning" },
  { id: "diagnosis", label: "Diagnostic accuracy" },
  { id: "treatment", label: "Treatment & follow-up" },
  { id: "communication", label: "Communication" },
];
const phaseTool: Record<"history" | "exam" | "diagnostics", ToolName> = {
  history: "record_history_topics",
  exam: "request_physical_exam",
  diagnostics: "order_diagnostic_test",
};
const planTool: Record<string, ToolName> = {
  treatment: "propose_treatment_plan",
  counseling: "propose_treatment_plan",
  disposition: "record_disposition",
  "follow-up": "record_follow_up",
  return: "record_follow_up",
};
const errorMessage = (e: unknown) =>
  e instanceof ApiRequestError ? e.message : "Something went wrong.";

function subscribeDevUser(callback: () => void) {
  window.addEventListener("clinicsim-dev-user", callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener("clinicsim-dev-user", callback);
    window.removeEventListener("storage", callback);
  };
}
function useDevUser(): string | null {
  return useSyncExternalStore(subscribeDevUser, getDevUser, () => null);
}
function useAuthStatus(): AuthStatus | null | "unreachable" {
  const user = useDevUser();
  const [status, setStatus] = useState<AuthStatus | null | "unreachable">(null);
  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus("unreachable"));
    return () => {
      cancelled = true;
    };
  }, [user]);
  return status;
}
function Portrait({
  config,
  small = false,
}: {
  config: { src?: string; alt: string; fallback: string };
  small?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`portrait ${small ? "portrait-small" : ""}`}>
      {config.src && !failed ? (
        <img
          src={config.src}
          alt={config.alt}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-label={config.alt}>{config.fallback}</span>
      )}
    </div>
  );
}
function IdentityControl() {
  const status = useAuthStatus();
  const user = useDevUser();
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  if (status === null) return null;
  if (status === "unreachable")
    return <span className="identity-note">Server unreachable</span>;
  if (!status.available)
    return <span className="identity-note">Sign-in not available</span>;
  if (user)
    return (
      <div className="identity-chip">
        <span>
          {user}
          <small>Development identity</small>
        </span>
        <button
          type="button"
          className="button button-quiet button-small"
          onClick={() => setDevUser(null)}
        >
          Switch
        </button>
      </div>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim().toLowerCase();
    if (!devUserSchema.safeParse(name).success) {
      setInvalid(true);
      return;
    }
    setDevUser(name);
  };
  return (
    <form className="identity-form" onSubmit={submit}>
      <label htmlFor="dev-user">Development identity</label>
      <input
        id="dev-user"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        placeholder="e.g. alice"
        aria-invalid={invalid}
        aria-describedby="dev-user-hint"
      />
      <button type="submit" className="button button-primary button-small">
        Use
      </button>
      <span
        id="dev-user-hint"
        className={invalid ? "identity-error" : "sr-only"}
      >
        2–32 lowercase letters, digits, dot, dash or underscore.
      </span>
    </form>
  );
}
function InsecureBanner() {
  const status = useAuthStatus();
  if (!status || status === "unreachable" || !status.insecure) return null;
  return (
    <div className="insecure-banner" role="alert">
      Demo deployment: identities are not verified. Anyone can view any
      user&rsquo;s practice history. Do not enter personal information.
    </div>
  );
}
function Header({ showIdentity = true }: { showIdentity?: boolean }) {
  return (
    <>
      <InsecureBanner />
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <Stethoscope size={18} />
          </span>
          <span>
            ClinicSim<small>PA learning lab</small>
          </span>
        </Link>
        <nav>
          <Link to="/cases">Case library</Link>
          <Link to="/dashboard">Dashboard</Link>
        </nav>
        {showIdentity && <IdentityControl />}
      </header>
    </>
  );
}
function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header />
      <main>{children}</main>
      <footer>
        <span>
          ClinicSim is an educational prototype using fictional patients.
        </span>
        <span>Requires qualified clinical review before formal use.</span>
      </footer>
    </>
  );
}
/** Renders children only when a user is available; otherwise explains why. */
function RequireUser({ children }: { children: ReactNode }) {
  const status = useAuthStatus();
  const user = useDevUser();
  if (status === null) return <div className="loading">Loading...</div>;
  if (status === "unreachable")
    return (
      <div className="empty-state">
        <h1>The ClinicSim server is not reachable</h1>
        <p className="lede">
          Practice requires the backend. Start it with <code>npm run dev</code>,
          then reload.
        </p>
      </div>
    );
  if (!status.available)
    return (
      <div className="empty-state">
        <h1>Sign-in is not available yet</h1>
        <p className="lede">
          This server has no sign-in configured, so practice cannot be saved.
        </p>
      </div>
    );
  if (!user)
    return (
      <div className="empty-state">
        <h1>Choose a development identity</h1>
        <p className="lede">
          Enter a name in the header to keep your practice history on this
          server. Development identities are not passwords; do not use personal
          information.
        </p>
      </div>
    );
  return <>{children}</>;
}
function LegacyNotice() {
  const [visible, setVisible] = useState(hasLegacyAttempts);
  if (!visible) return null;
  return (
    <div className="legacy-notice" role="status">
      <div>
        <strong>Older practice results on this device</strong>
        <p>
          Results saved by an earlier version stayed in this browser and were
          scored here, not by the server. They cannot be verified or tied to an
          identity, so they are not imported into your history.
        </p>
      </div>
      <button
        type="button"
        className="button button-quiet button-small"
        onClick={() => {
          deleteLegacyAttempts();
          setVisible(false);
        }}
      >
        Delete local results
      </button>
    </div>
  );
}
function Home() {
  return (
    <div className="home">
      <Header showIdentity={false} />
      <main className="home-main">
        <div className="home-columns">
          <div className="home-copy">
            <p className="home-kicker">
              <span>ClinicSim field guide</span>
              <i aria-hidden="true" />
              <span>Practice edition</span>
            </p>
            <h1 className="home-headline">
              Turn knowledge into clinical conversation.
            </h1>
            <p className="home-lede">
              Choose the kind of encounter you want to practice. Speak
              naturally, reason aloud, and learn by doing.
            </p>
            <ol className="home-actions">
              <li>
                <span className="home-numeral" aria-hidden="true">
                  I
                </span>
                <div className="home-action-copy">
                  <h2>
                    <Link to="/cases" className="home-action-link">
                      Start OSCE Practice
                    </Link>
                  </h2>
                  <p>
                    Interview a patient, examine, and commit to an assessment
                    and plan, then review your debrief.
                  </p>
                </div>
                <span className="home-action-tag">Conduct an encounter</span>
                <span className="home-action-arrow" aria-hidden="true">
                  <ArrowUpRight size={17} />
                </span>
              </li>
              <li className="home-action--unavailable">
                <span className="home-numeral" aria-hidden="true">
                  II
                </span>
                <div className="home-action-copy">
                  <h2>Start Clinical Sim</h2>
                  <p>
                    Take responsibility for workup, treatment, and disposition
                    as the patient evolves.
                  </p>
                </div>
                <span className="home-action-tag">Manage a patient</span>
                <span className="home-action-badge">Coming soon</span>
              </li>
            </ol>
          </div>
          <figure className="home-figure">
            <div
              className="home-plate"
              role="img"
              aria-label="Illustration of an open study book beside a stethoscope"
            >
              <span className="home-plate-label" aria-hidden="true">
                Plate 01
              </span>
              <div className="home-plate-art" aria-hidden="true">
                <div className="home-book">
                  <span className="home-book-spine" />
                  <span className="home-book-page home-book-page--left" />
                  <span className="home-book-page home-book-page--right" />
                </div>
                <Stethoscope size={44} strokeWidth={1.4} />
              </div>
            </div>
            <figcaption>
              <em>Fig. A</em> Use ClinicSim alongside your reading: move from a
              study prompt into a spoken patient encounter while the material is
              fresh.
            </figcaption>
          </figure>
        </div>
      </main>
      <div className="home-banner">
        <p>Practice the encounter, not just the answer.</p>
        <Link to="/cases" className="home-banner-button">
          Browse practice cases <Mic size={15} aria-hidden="true" />
        </Link>
      </div>
      <footer>
        <span>
          ClinicSim is an educational prototype using fictional patients.
        </span>
        <span>Requires qualified clinical review before formal use.</span>
      </footer>
    </div>
  );
}
function Dashboard() {
  return (
    <Layout>
      <LegacyNotice />
      <RequireUser>
        <DashboardContent />
      </RequireUser>
    </Layout>
  );
}
function DashboardContent() {
  const user = useDevUser();
  const [items, setItems] = useState<AttemptSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchPage = (after?: string) =>
    api
      .history({ limit: 10, cursor: after })
      .then((page) => {
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  const load = (after?: string) => {
    setLoading(true);
    setError(null);
    void fetchPage(after);
  };
  useEffect(() => {
    void api
      .history({ limit: 10 })
      .then((page) => {
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [user]);
  const completed = items.filter((a) => a.status === "submitted");
  const average = completed.length
    ? Math.round(
        completed.reduce((n, a) => n + (a.finalScore ?? 0), 0) /
          completed.length,
      )
    : null;
  return (
    <>
      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">PRACTICE HISTORY</p>
          <h1>
            Practice the encounter.
            <br />
            <em>Sharpen the judgment.</em>
          </h1>
          <p className="lede">
            Your submitted encounters are scored by the server and saved to this
            identity.
          </p>
          <Link className="button button-primary" to="/cases">
            Start an encounter <ArrowRight size={17} />
          </Link>
        </div>
      </section>
      <section className="stats-grid">
        <Stat
          icon={<BarChart3 size={19} />}
          tone="teal"
          value={<>{completed.length}</>}
          label="Submitted encounters loaded"
        />
        <Stat
          icon={<ClipboardList size={19} />}
          tone="amber"
          value={
            <>
              {average ?? "—"}
              <small>{average !== null ? "%" : ""}</small>
            </>
          }
          label="Average score"
        />
        <Stat
          icon={<Check size={19} />}
          tone="blue"
          value={
            <>
              {completed.filter((a) => a.passed).length}
              <small> / {completed.length}</small>
            </>
          }
          label="Passes"
        />
      </section>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">RECENT ACTIVITY</p>
            <h2>Your encounters</h2>
          </div>
          <Link to="/cases" className="text-link">
            View all cases <ArrowRight size={15} />
          </Link>
        </div>
        {error && (
          <div className="voice-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}
        {!loading && !error && items.length === 0 && (
          <p className="muted">
            No encounters yet. Choose a case to start your first one.
          </p>
        )}
        {items.map((a) => (
          <div className="attempt-row" key={a.id}>
            <div className="case-dot">
              {a.scenarioId.slice(0, 2).toUpperCase()}
            </div>
            <div className="attempt-copy">
              <strong>{a.scenarioTitle}</strong>
              <span>
                {a.status === "active"
                  ? "In progress"
                  : a.passed
                    ? "Passed"
                    : "Needs review"}{" "}
                · {new Date(a.submittedAt ?? a.createdAt).toLocaleDateString()}
              </span>
            </div>
            {a.status === "submitted" ? (
              <strong className={a.passed ? "score-pass" : "score-fail"}>
                {a.finalScore}%
              </strong>
            ) : (
              <span className="case-status">Active</span>
            )}
            <Link
              aria-label={
                a.status === "submitted"
                  ? `Review ${a.scenarioTitle}`
                  : `Resume ${a.scenarioTitle}`
              }
              className="icon-button"
              to={
                a.status === "submitted"
                  ? `/results/${a.id}`
                  : `/encounter/${a.scenarioId}`
              }
            >
              <ArrowRight size={16} />
            </Link>
          </div>
        ))}
        {cursor && (
          <button
            type="button"
            className="button button-quiet"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        )}
      </section>
    </>
  );
}
function Cases() {
  const user = useDevUser();
  const [scenarios, setScenarios] = useState<PublicScenario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<
    Record<string, "active" | "submitted">
  >({});
  useEffect(() => {
    api
      .scenarios()
      .then(setScenarios)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    if (!user) return;
    // Status labels are a convenience; the first page is enough to mark recent work.
    api
      .history({ limit: 50 })
      .then((page) => {
        const next: Record<string, "active" | "submitted"> = {};
        for (const a of [...page.items].reverse())
          next[a.scenarioId] = a.status;
        setStatusById(next);
      })
      .catch(() => setStatusById({}));
  }, [user]);
  return (
    <Layout>
      <LegacyNotice />
      <section className="page-intro">
        <div>
          <p className="eyebrow">CASE LIBRARY</p>
          <h1>Choose a patient to meet.</h1>
          <p className="lede">
            Work through each encounter from the PA student perspective.
            Diagnoses stay hidden until you submit.
          </p>
        </div>
        {scenarios && (
          <div className="library-count">
            <strong>{scenarios.length}</strong>
            <span>
              authored cases
              <br />
              ready to practice
            </span>
          </div>
        )}
      </section>
      {error && (
        <div className="voice-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {!scenarios && !error && <div className="loading">Loading cases...</div>}
      <div className="case-grid">
        {scenarios?.map((s) => {
          const status = statusById[s.id];
          return (
            <article className="case-card" key={s.id}>
              <div className="case-card-top">
                <span className={`tag ${s.summary.urgent ? "tag-amber" : ""}`}>
                  {s.summary.urgent ? "Urgent decision" : "Routine visit"}
                </span>
                <span className="case-status">
                  {status === "active"
                    ? "In progress"
                    : status === "submitted"
                      ? "Completed"
                      : "Not started"}
                </span>
              </div>
              <h2>{s.summary.title}</h2>
              <p>{s.summary.complaint}</p>
              <div className="case-meta">
                <span>
                  {s.summary.age} · {s.summary.pronouns}
                </span>
                <span>
                  <Clock3 size={14} />
                  {s.summary.duration}
                </span>
              </div>
              <div className="case-footer">
                <span className="difficulty">{s.summary.difficulty}</span>
                <Link className="button button-small" to={`/encounter/${s.id}`}>
                  {status === "active"
                    ? "Resume"
                    : status === "submitted"
                      ? "Replay"
                      : "Begin"}{" "}
                  <ArrowRight size={15} />
                </Link>
              </div>
            </article>
          );
        })}
      </div>
    </Layout>
  );
}
function Encounter() {
  return (
    <Layout>
      <RequireUser>
        <EncounterContent />
      </RequireUser>
    </Layout>
  );
}
function EncounterContent() {
  const { scenarioId } = useParams();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<PublicAttempt | null>(null);
  const [resumed, setResumed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Diagnosis and plan choices are drafts until the student locks the phase.
  const [draft, setDraft] = useState<{
    diagnosis: string[];
    treatment: string[];
  }>({ diagnosis: [], treatment: [] });
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!scenarioId) return;
    let cancelled = false;
    api
      .startAttempt(scenarioId)
      .then((res) => {
        if (cancelled) return;
        setAttempt(res.attempt);
        setResumed(res.resumed);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiRequestError && e.code === "scenario_not_found")
          navigate("/cases");
        else setLoadError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [scenarioId, navigate]);

  const attemptId = attempt?.id;
  // Keyed on the ID only: depending on `attempt` would re-fire the voice panel's effect after every refresh.
  const refresh = useCallback(() => {
    if (!attemptId) return;
    api
      .attempt(attemptId)
      .then(setAttempt)
      .catch(() => undefined);
  }, [attemptId]);

  if (loadError)
    return (
      <div className="empty-state">
        <h1>Could not open this encounter</h1>
        <p className="lede">{loadError}</p>
        <Link className="button button-primary" to="/cases">
          Return to cases
        </Link>
      </div>
    );
  if (!attempt) return <div className="loading">Loading encounter...</div>;

  const scenario = attempt.scenario;
  const phase = attempt.currentPhase;
  const phaseIndex = phaseOrder.indexOf(phase);
  const phaseDef = scenario.phases.find((p) => p.id === phase)!;
  const locked = attempt.lockedPhases;
  const recorded = attempt.events
    .filter((e) => e.phase === phase)
    .map((e) => e.actionId);
  const activeIds =
    phase === "diagnosis" || phase === "treatment" ? draft[phase] : recorded;

  const run = async (fn: () => Promise<PublicAttempt>) => {
    setBusy(true);
    setActionError(null);
    try {
      setAttempt(await fn());
      return true;
    } catch (e) {
      setActionError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const choose = (id: string) => {
    if (busy || locked.includes(phase)) return;
    if (phase === "diagnosis") {
      setDraft((d) => ({ ...d, diagnosis: [id] }));
      return;
    }
    if (phase === "treatment") {
      setDraft((d) => ({
        ...d,
        treatment: d.treatment.includes(id)
          ? d.treatment.filter((v) => v !== id)
          : [...d.treatment, id],
      }));
      return;
    }
    if (recorded.includes(id)) return;
    void run(async () => {
      const res = await api.event(attempt.id, {
        type: "action",
        tool: phaseTool[phase],
        actionIds: [id],
      });
      return res.attempt;
    });
  };

  const commitDrafts = async (): Promise<PublicAttempt> => {
    let latest = attempt;
    if (phase === "diagnosis" && draft.diagnosis.length) {
      latest = (
        await api.event(attempt.id, {
          type: "action",
          tool: "propose_diagnosis",
          actionIds: draft.diagnosis,
          confirmed: true,
        })
      ).attempt;
    }
    if (phase === "treatment") {
      const byTool = new Map<ToolName, string[]>();
      for (const id of draft.treatment) {
        const group = scenario.planOptions.find((p) => p.id === id)?.group;
        const tool = group ? planTool[group] : undefined;
        if (tool) byTool.set(tool, [...(byTool.get(tool) ?? []), id]);
      }
      for (const [tool, actionIds] of byTool) {
        latest = (
          await api.event(attempt.id, {
            type: "action",
            tool,
            actionIds,
            confirmed: true,
          })
        ).attempt;
      }
    }
    return latest;
  };

  const advance = async () => {
    const ok = await run(async () => {
      await commitDrafts();
      return (await api.event(attempt.id, { type: "lock_phase", phase }))
        .attempt;
    });
    if (ok) setConfirm(false);
  };

  const submit = async () => {
    const ok = await run(async () => {
      await commitDrafts();
      return api.submit(attempt.id);
    });
    if (ok) navigate(`/results/${attempt.id}`);
  };

  const options =
    phase === "diagnosis"
      ? scenario.diagnoses.map((d) => ({
          id: d.id,
          label: d.label,
          paText: "Select primary diagnosis",
        }))
      : phase === "treatment"
        ? scenario.planOptions.map((p) => ({
            id: p.id,
            label: p.label,
            paText: "Add to care plan",
          }))
        : phaseDef.actions;
  const revealed = attempt.events.filter(
    (e) => e.revealed && e.phase !== "diagnosis" && e.phase !== "treatment",
  );

  if (attempt.status === "submitted")
    return <Navigate to={`/results/${attempt.id}`} replace />;

  return (
    <>
      <div className="encounter-shell">
        <div className="encounter-header">
          <div>
            <Link to="/cases" className="back-link">
              <ChevronLeft size={15} /> Exit encounter
            </Link>
            <p className="eyebrow">
              ACTIVE ENCOUNTER · {scenario.summary.setting.toUpperCase()}
              {resumed && (attempt.events.length > 0 || locked.length > 0)
                ? " · RESUMED"
                : ""}
            </p>
            <h1>{scenario.summary.title}</h1>
          </div>
          <div className="patient-quick">
            <Portrait config={scenario.patient.portrait} small />
            <span>
              <strong>{scenario.patient.name}</strong>
              <small>
                {scenario.patient.demographics} · {scenario.summary.pronouns}
              </small>
            </span>
          </div>
        </div>
        <div className="steps">
          {phaseOrder.map((p, i) => (
            <div
              className={`step ${i === phaseIndex ? "active" : ""} ${locked.includes(p) ? "done" : ""}`}
              key={p}
            >
              <span>{locked.includes(p) ? <Check size={14} /> : i + 1}</span>
              <label>{scenario.phases.find((x) => x.id === p)?.label}</label>
            </div>
          ))}
        </div>
        <VoicePanel attemptId={attempt.id} onActivity={refresh} />
        <div className="encounter-grid">
          <aside className="speaker-side clinician-side">
            <Portrait config={scenario.clinician} />
            <strong>You — PA Student</strong>
            <span>Clinician perspective</span>
          </aside>
          <section className="transcript">
            <div className="patient-opening">
              <div className="turn-label">
                <span className="patient-dot">
                  {scenario.patient.portrait.fallback}
                </span>
                <strong>{scenario.patient.name}</strong>
                <small>Patient</small>
              </div>
              <p>“{scenario.opening}”</p>
            </div>
            <div className="known-info">
              <strong>Initial information</strong>
              {scenario.initialInfo.map((x) => (
                <span key={x}>{x}</span>
              ))}
            </div>
            {revealed.map((r) => (
              <div className="turn" key={r.seq}>
                <div className="turn-label">
                  <span className="pa-dot">PA</span>
                  <strong>
                    {scenario.phases.find((p) => p.id === r.phase)?.label}
                  </strong>
                  <small>
                    {r.source === "voice"
                      ? "Recorded from voice"
                      : "Finding revealed"}
                  </small>
                </div>
                <p>{r.revealed}</p>
              </div>
            ))}
            <div aria-live="polite" className="sr-only">
              {revealed.length} findings revealed
            </div>
          </section>
          <aside className="speaker-side patient-side">
            <Portrait config={scenario.patient.portrait} />
            <strong>{scenario.patient.name}</strong>
            <span>Fictional patient</span>
          </aside>
        </div>
        <section className="action-panel">
          <div className="action-heading">
            <div>
              <p className="eyebrow">PHASE {phaseIndex + 1} OF 5</p>
              <h2>{phaseDef.label}</h2>
              <p>{phaseDef.description}</p>
            </div>
            <span className="selection-count">{activeIds.length} selected</span>
          </div>
          {actionError && (
            <div className="voice-error" role="alert">
              <p>{actionError}</p>
            </div>
          )}
          {options.map((a) => (
            <button
              type="button"
              className={`action-option ${activeIds.includes(a.id) ? "selected" : ""}`}
              key={a.id}
              aria-pressed={activeIds.includes(a.id)}
              disabled={busy}
              onClick={() => choose(a.id)}
            >
              <span className="action-check">
                {activeIds.includes(a.id) ? <Check size={14} /> : ""}
              </span>
              <span>
                <strong>{a.label}</strong>
                <small>{a.paText}</small>
              </span>
            </button>
          ))}
          <div className="action-footer">
            <span>
              {locked.includes(phase) ? (
                <>
                  <Lock size={14} /> Phase locked
                </>
              ) : phase === "diagnosis" ? (
                "Choose one primary diagnosis. It is saved when you lock the phase."
              ) : phase === "treatment" ? (
                "Choose all plan elements. They are saved when you submit."
              ) : (
                "Each choice is saved as you make it."
              )}
            </span>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => setConfirm(true)}
            >
              {phaseIndex < 4 ? "Advance phase" : "Review and submit"}{" "}
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      </div>
      {confirm && (
        <Modal
          title={phaseIndex < 4 ? "Lock this phase?" : "Ready to submit?"}
          onClose={() => setConfirm(false)}
        >
          <p>
            {phaseIndex < 4
              ? "You will be able to review this phase later, but its selections cannot be edited after advancing."
              : "Your choices will be graded by the server only after submission."}
          </p>
          {actionError && (
            <p className="voice-error" role="alert">
              {actionError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="button button-quiet"
              onClick={() => setConfirm(false)}
            >
              Keep working
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void (phaseIndex < 4 ? advance() : submit())}
            >
              {busy
                ? "Saving..."
                : phaseIndex < 4
                  ? "Lock and advance"
                  : "Submit encounter"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Results() {
  return (
    <Layout>
      <RequireUser>
        <ResultsContent />
      </RequireUser>
    </Layout>
  );
}
function ResultsContent() {
  const { attemptId } = useParams();
  const [attempt, setAttempt] = useState<PublicAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!attemptId) return;
    api
      .attempt(attemptId)
      .then(setAttempt)
      .catch((e) => setError(errorMessage(e)));
  }, [attemptId]);
  if (error || (attempt && !attempt.debrief))
    return (
      <div className="empty-state">
        <h1>Result not found</h1>
        <p className="lede">
          {error ?? "This encounter has not been submitted yet."}
        </p>
        <Link className="button button-primary" to="/cases">
          Return to cases
        </Link>
      </div>
    );
  if (!attempt) return <div className="loading">Loading debrief...</div>;
  const scenario = attempt.scenario;
  const result = attempt.debrief!;
  return (
    <>
      <section className="results-head">
        <div>
          <p className="eyebrow">
            ENCOUNTER DEBRIEF · {scenario.summary.title.toUpperCase()}
          </p>
          <h1>
            {result.passed ? "Strong clinical work." : "A useful next review."}
          </h1>
          <p className="lede">
            This feedback reflects the authored rubric for this fictional case
            and has not been clinically validated.
          </p>
          <p className="muted">
            Graded {new Date(result.gradedAt).toLocaleString()} · rubric{" "}
            {result.gradingVersionId} · case version {result.contentVersionId}
          </p>
        </div>
        <div className={`score-hero ${result.passed ? "pass" : "fail"}`}>
          <strong>
            {result.finalScore}
            <small>%</small>
          </strong>
          <span>{result.passed ? "Passed" : "Not passed"}</span>
        </div>
      </section>
      {result.criticalSafetyError && (
        <div className="critical-banner">
          <ShieldAlert size={22} />
          <div>
            <strong>Critical safety error</strong>
            <p>{result.criticalMessages.join(" ")}</p>
            <small>
              Raw score: {result.rawScore}%. Displayed score is capped at 59%
              when a critical safety error occurs.
            </small>
          </div>
        </div>
      )}
      <section className="results-grid">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">RUBRIC BREAKDOWN</p>
              <h2>Category scores</h2>
            </div>
            <span className="raw-score">Raw {result.rawScore}%</span>
          </div>
          {categories.map((c) => (
            <div className="bar-row" key={c.id}>
              <div>
                <span>{c.label}</span>
                <strong>{result.categoryScores[c.id]}%</strong>
              </div>
              <div className="bar">
                <i style={{ width: `${result.categoryScores[c.id]}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="panel feedback-panel">
          <p className="eyebrow">DEBRIEF NOTES</p>
          <Feedback title="What went well" items={result.strengths} />
          <Feedback title="Important misses" items={result.missed} />
          <Feedback
            title="Unnecessary or unsafe"
            items={[...result.unnecessary, ...result.unsafe]}
          />
        </div>
      </section>
      <section className="results-grid lower">
        <div className="panel">
          <p className="eyebrow">DIAGNOSTIC REASONING</p>
          <h2>{result.correctDiagnosisLabel}</h2>
          <p>{result.diagnosisReasoning}</p>
          <div className="ideal-plan">
            <strong>Recommended plan</strong>
            {result.idealPlan.map((x) => (
              <span key={x}>
                <Check size={14} />
                {x}
              </span>
            ))}
          </div>
        </div>
        <div className="panel">
          <p className="eyebrow">NEXT STEP</p>
          <h2>Keep building clinical fluency</h2>
          <p>
            Replay the case to try a different path, or return to the library
            for another fictional patient.
          </p>
          <div className="modal-actions">
            <Link
              className="button button-primary"
              to={`/encounter/${scenario.id}`}
            >
              Replay case <RotateCcw size={15} />
            </Link>
            <Link className="button button-quiet" to="/cases">
              Case library
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
function Stat({
  icon,
  tone,
  value,
  label,
  progress,
}: {
  icon: ReactNode;
  tone: string;
  value: ReactNode;
  label: string;
  progress?: number;
}) {
  return (
    <div className="stat-card">
      <span className={`stat-icon ${tone}`}>{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
      {progress !== undefined && (
        <div className="mini-progress">
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal">
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={18} />
        </button>
        <p className="eyebrow">CONFIRMATION</p>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
function Feedback({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="feedback-block">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing recorded for this section.</p>
      )}
    </div>
  );
}
function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/cases" element={<Cases />} />
      <Route path="/encounter/:scenarioId" element={<Encounter />} />
      <Route path="/results/:attemptId" element={<Results />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
export default App;
