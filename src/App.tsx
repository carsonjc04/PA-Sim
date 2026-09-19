import { useEffect, useState, type ReactNode } from "react";
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
  BarChart3,
  Check,
  ChevronLeft,
  ClipboardList,
  Clock3,
  Lock,
  RotateCcw,
  ShieldAlert,
  Stethoscope,
  X,
} from "lucide-react";
import type {
  Attempt,
  Category,
  PhaseId,
  ScenarioDefinition,
} from "./domain/types";
import { phaseOrder } from "./domain/types";
import { gradeAttempt } from "./domain/grading";
import { staticScenarioProvider } from "./providers/static";
import { loadAttempts, resetAttempts, saveAttempts } from "./storage";

const categories: { id: Category; label: string }[] = [
  { id: "history", label: "History taking" },
  { id: "exam", label: "Physical examination" },
  { id: "diagnostics", label: "Diagnostics & reasoning" },
  { id: "diagnosis", label: "Diagnostic accuracy" },
  { id: "treatment", label: "Treatment & follow-up" },
  { id: "communication", label: "Communication" },
];
const seedAttempts = (): Attempt[] => [
  {
    id: "demo-respiratory",
    scenarioId: "respiratory",
    startedAt: "2026-09-12T09:00:00Z",
    completedAt: "2026-09-12T09:14:00Z",
    selectedByPhase: {
      history: [],
      exam: [],
      diagnostics: [],
      diagnosis: [],
      treatment: [],
    },
    phaseLocks: phaseOrder,
    revealed: [],
    submitted: true,
    rawScore: 78,
    finalScore: 78,
    passed: true,
  },
  {
    id: "demo-asthma",
    scenarioId: "asthma",
    startedAt: "2026-09-14T14:00:00Z",
    completedAt: "2026-09-14T14:12:00Z",
    selectedByPhase: {
      history: [],
      exam: [],
      diagnostics: [],
      diagnosis: [],
      treatment: [],
    },
    phaseLocks: phaseOrder,
    revealed: [],
    submitted: true,
    rawScore: 66,
    finalScore: 66,
    passed: false,
  },
];
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
function Header() {
  return (
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
        <Link to="/">Dashboard</Link>
      </nav>
      <div className="profile-chip">
        <span className="avatar">AS</span>
        <span>
          Alex Morgan<small>PA-S student</small>
        </span>
      </div>
    </header>
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
function Dashboard() {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  useEffect(() => {
    const saved = loadAttempts();
    setAttempts(saved.length ? saved : seedAttempts());
    staticScenarioProvider.listScenarios().then(setScenarios);
  }, []);
  const done = new Set(
    attempts.filter((a) => a.submitted).map((a) => a.scenarioId),
  );
  const completed = attempts.filter((a) => a.submitted);
  const average = completed.length
    ? Math.round(
        completed.reduce((n, a) => n + (a.finalScore ?? 0), 0) /
          completed.length,
      )
    : 0;
  return (
    <Layout>
      <section className="dashboard-hero">
        <div>
          <p className="eyebrow">GOOD MORNING, ALEX</p>
          <h1>
            Practice the encounter.
            <br />
            <em>Sharpen the judgment.</em>
          </h1>
          <p className="lede">
            A focused clinical simulation space for building confident,
            patient-centered primary care habits.
          </p>
          <Link className="button button-primary" to="/cases">
            Start an encounter <ArrowRight size={17} />
          </Link>
        </div>
        <div className="hero-note">
          <span className="note-icon">
            <ShieldAlert size={18} />
          </span>
          <div>
            <strong>Private learning space</strong>
            <p>
              All encounters are fictional. Your practice history stays on this
              device.
            </p>
          </div>
        </div>
      </section>
      <section className="stats-grid">
        <Stat
          icon={<BarChart3 size={19} />}
          tone="teal"
          value={
            <>
              {done.size}
              <small> / {scenarios.length || 5}</small>
            </>
          }
          label="Cases completed"
          progress={done.size / 5}
        />
        <Stat
          icon={<ClipboardList size={19} />}
          tone="amber"
          value={
            <>
              {average || "—"}
              <small>{average ? "%" : ""}</small>
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
      <section className="content-grid">
        <div className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">RECENT ACTIVITY</p>
              <h2>Keep your momentum</h2>
            </div>
            <Link to="/cases" className="text-link">
              View all cases <ArrowRight size={15} />
            </Link>
          </div>
          {completed.map((a) => (
            <div className="attempt-row" key={a.id}>
              <div className="case-dot">
                {a.scenarioId.slice(0, 2).toUpperCase()}
              </div>
              <div className="attempt-copy">
                <strong>
                  {scenarios.find((s) => s.id === a.scenarioId)?.summary
                    .title || "Demo encounter"}
                </strong>
                <span>
                  {a.passed ? "Passed" : "Needs review"} ·{" "}
                  {new Date(a.completedAt ?? a.startedAt).toLocaleDateString()}
                </span>
              </div>
              <strong className={a.passed ? "score-pass" : "score-fail"}>
                {a.finalScore}%
              </strong>
              <Link
                aria-label="Review attempt"
                className="icon-button"
                to={`/results/${a.id}`}
              >
                <ArrowRight size={16} />
              </Link>
            </div>
          ))}
        </div>
        <div className="panel profile-panel">
          <p className="eyebrow">YOUR PROFILE</p>
          <div className="profile-large">
            <span className="avatar avatar-large">AM</span>
            <div>
              <h2>Alex Morgan</h2>
              <p>PA-S · North Coast University</p>
            </div>
          </div>
          <div className="profile-rule" />
          <div className="focus-row">
            <span>Current focus</span>
            <strong>Clinical reasoning</strong>
          </div>
          <div className="focus-row">
            <span>Cases in library</span>
            <strong>{scenarios.length || 5}</strong>
          </div>
          <button
            className="button button-quiet"
            onClick={() => {
              resetAttempts();
              setAttempts(seedAttempts());
            }}
          >
            <RotateCcw size={15} /> Reset demo data
          </button>
        </div>
      </section>
    </Layout>
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
function Cases() {
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [attempts] = useState(loadAttempts);
  useEffect(() => {
    staticScenarioProvider.listScenarios().then(setScenarios);
  }, []);
  return (
    <Layout>
      <section className="page-intro">
        <div>
          <p className="eyebrow">CASE LIBRARY</p>
          <h1>Choose a patient to meet.</h1>
          <p className="lede">
            Work through each encounter from the PA student perspective.
            Diagnoses stay hidden until you submit.
          </p>
        </div>
        <div className="library-count">
          <strong>{scenarios.length || 5}</strong>
          <span>
            authored cases
            <br />
            ready to practice
          </span>
        </div>
      </section>
      <div className="case-grid">
        {scenarios.map((s) => (
          <article className="case-card" key={s.id}>
            <div className="case-card-top">
              <span className={`tag ${s.summary.urgent ? "tag-amber" : ""}`}>
                {s.summary.urgent ? "Urgent decision" : "Routine visit"}
              </span>
              <span className="case-status">
                {attempts.some((a) => a.scenarioId === s.id && a.submitted)
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
                {attempts.some((a) => a.scenarioId === s.id && a.submitted)
                  ? "Replay"
                  : "Begin"}{" "}
                <ArrowRight size={15} />
              </Link>
            </div>
          </article>
        ))}
      </div>
    </Layout>
  );
}
function Encounter({ onSubmit }: { onSubmit: (a: Attempt) => void }) {
  const { scenarioId } = useParams();
  const navigate = useNavigate();
  const [scenario, setScenario] = useState<ScenarioDefinition>();
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [selected, setSelected] = useState<Record<PhaseId, string[]>>({
    history: [],
    exam: [],
    diagnostics: [],
    diagnosis: [],
    treatment: [],
  });
  const [revealed, setRevealed] = useState<
    { phase: PhaseId; actionId: string; text: string }[]
  >([]);
  const [locked, setLocked] = useState<PhaseId[]>([]);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (scenarioId)
      staticScenarioProvider
        .getScenario(scenarioId)
        .then(setScenario)
        .catch(() => navigate("/cases"));
  }, [scenarioId, navigate]);
  if (!scenario)
    return (
      <Layout>
        <div className="loading">Loading encounter...</div>
      </Layout>
    );
  const phase = phaseOrder[phaseIndex];
  const phaseDef = scenario.phases.find((p) => p.id === phase)!;
  const activeIds = selected[phase];
  const visible = phaseDef.actions.filter(
    (a) =>
      !a.rule?.requires?.some((id) => !selected[phase].includes(id)) &&
      !a.rule?.excludes?.some((id) => selected[phase].includes(id)),
  );
  const choose = (id: string, text: string) => {
    if (locked.includes(phase)) return;
    if (phase === "diagnosis" || phase === "treatment") {
      setSelected((x) => ({
        ...x,
        [phase]:
          phase === "diagnosis"
            ? [id]
            : x[phase].includes(id)
              ? x[phase].filter((v) => v !== id)
              : [...x[phase], id],
      }));
      return;
    }
    if (activeIds.includes(id)) return;
    setSelected((x) => ({ ...x, [phase]: [...x[phase], id] }));
    setRevealed((x) => [...x, { phase, actionId: id, text }]);
  };
  const advance = () => {
    setLocked((x) => [...x, phase]);
    if (phaseIndex < phaseOrder.length - 1) setPhaseIndex(phaseIndex + 1);
    setConfirm(false);
  };
  const submit = () => {
    const a: Attempt = {
      id: `attempt-${Date.now()}`,
      scenarioId: scenario.id,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      selectedByPhase: selected,
      phaseLocks: phaseOrder,
      revealed,
      submitted: true,
    };
    onSubmit(a);
    navigate(`/results/${a.id}`);
  };
  const options =
    phase === "diagnosis"
      ? scenario.diagnoses.map((d) => ({
          id: d.id,
          label: d.label,
          paText: "Select primary diagnosis",
          response: d.reasoning ?? "",
          kind: "choice" as const,
        }))
      : phase === "treatment"
        ? scenario.planOptions.map((p) => ({
            id: p.id,
            label: p.label,
            paText: "Add to care plan",
            response:
              p.unsafeReason ?? "Plan element recorded for final review.",
            kind: "choice" as const,
          }))
        : visible;
  return (
    <Layout>
      <div className="encounter-shell">
        <div className="encounter-header">
          <div>
            <Link to="/cases" className="back-link">
              <ChevronLeft size={15} /> Exit encounter
            </Link>
            <p className="eyebrow">
              ACTIVE ENCOUNTER · {scenario.summary.setting.toUpperCase()}
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
            {revealed.map((r, i) => (
              <div className="turn" key={`${r.actionId}-${i}`}>
                <div className="turn-label">
                  <span className="pa-dot">PA</span>
                  <strong>
                    {scenario.phases.find((p) => p.id === r.phase)?.label}
                  </strong>
                  <small>Finding revealed</small>
                </div>
                <p>{r.text}</p>
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
          {options.map((a) => (
            <button
              type="button"
              className={`action-option ${activeIds.includes(a.id) ? "selected" : ""}`}
              key={a.id}
              onClick={() => choose(a.id, a.response)}
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
                "Choose one primary diagnosis."
              ) : phase === "treatment" ? (
                "Choose all plan elements you would include."
              ) : (
                "Choose any actions in the order you prefer."
              )}
            </span>
            {phaseIndex < 4 ? (
              <button
                className="button button-primary"
                onClick={() => setConfirm(true)}
              >
                Advance phase <ArrowRight size={16} />
              </button>
            ) : (
              <button
                className="button button-primary"
                onClick={() => setConfirm(true)}
              >
                Review and submit <ArrowRight size={16} />
              </button>
            )}
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
              : "Your choices will be graded only after submission."}
          </p>
          <div className="modal-actions">
            <button
              className="button button-quiet"
              onClick={() => setConfirm(false)}
            >
              Keep working
            </button>
            {phaseIndex < 4 ? (
              <button className="button button-primary" onClick={advance}>
                Lock and advance
              </button>
            ) : (
              <button className="button button-primary" onClick={submit}>
                Submit encounter
              </button>
            )}
          </div>
        </Modal>
      )}
    </Layout>
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
function Results({ attempts }: { attempts: Attempt[] }) {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const attempt = attempts.find((a) => a.id === attemptId);
  const [scenario, setScenario] = useState<ScenarioDefinition>();
  useEffect(() => {
    if (attempt)
      staticScenarioProvider.getScenario(attempt.scenarioId).then(setScenario);
  }, [attempt]);
  if (!attempt || !scenario)
    return (
      <Layout>
        <div className="empty-state">
          <h1>Result not found</h1>
          <Link className="button button-primary" to="/cases">
            Return to cases
          </Link>
        </div>
      </Layout>
    );
  const result = attempt.feedback ?? gradeAttempt(scenario, attempt);
  return (
    <Layout>
      <section className="results-head">
        <div>
          <p className="eyebrow">
            ENCOUNTER DEBRIEF · {scenario.summary.title.toUpperCase()}
          </p>
          <h1>
            {result.passed ? "Strong clinical work." : "A useful next review."}
          </h1>
          <p className="lede">
            This feedback is available after submission and reflects the
            authored rubric for this fictional case.
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
          <h2>
            {
              scenario.diagnoses.find((d) => d.id === scenario.correctPrimary)
                ?.label
            }
          </h2>
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
            <button
              className="button button-primary"
              onClick={() => navigate(`/encounter/${scenario.id}`)}
            >
              Replay case <RotateCcw size={15} />
            </button>
            <Link className="button button-quiet" to="/cases">
              Case library
            </Link>
          </div>
        </div>
      </section>
    </Layout>
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
  const [attempts, setAttempts] = useState<Attempt[]>(loadAttempts);
  const submit = (a: Attempt) => {
    staticScenarioProvider.getScenario(a.scenarioId).then((s) => {
      const result = gradeAttempt(s, a);
      const finished = {
        ...a,
        feedback: result,
        rawScore: result.rawScore,
        finalScore: result.finalScore,
        passed: result.passed,
      };
      setAttempts((x) => {
        const next = [...x, finished];
        saveAttempts(next);
        return next;
      });
    });
  };
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/cases" element={<Cases />} />
      <Route
        path="/encounter/:scenarioId"
        element={<Encounter onSubmit={submit} />}
      />
      <Route
        path="/results/:attemptId"
        element={<Results attempts={attempts} />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
export default App;
