import {
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
} from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Clock3,
  Mic,
  Stethoscope,
} from "lucide-react";
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
  type PublicScenario,
} from "./api/contracts";
import { EncounterPage } from "./features/encounter/EncounterPage";
import { DebriefPage } from "./features/debrief/DebriefPage";
import { ReviewDueNote } from "./features/review/ReviewDueNote";
import { ProgressDashboard } from "./features/analytics/ProgressDashboard";
import { SettingsButton } from "./features/settings/SettingsDialog";
import { TodayReview } from "./features/review/TodayReview";
import { CaseFilters } from "./features/study/CaseFilters";
import { useCaseFilters } from "./features/study/filterState";
import { MixedMode } from "./features/study/MixedMode";
import { PanceMode } from "./features/study/PanceMode";
import { RotationMode } from "./features/study/RotationMode";
import { SprintMode } from "./features/study/SprintMode";
import { StudyHome } from "./features/study/StudyHome";

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
      Demo deployment: identities are not verified &mdash; anyone can sign in as
      any name, but each identity only sees its own practice history. Do not
      enter personal information.
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
          <Link to="/study">Study modes</Link>
          <Link to="/review">Today&rsquo;s review</Link>
          <Link to="/dashboard">Dashboard</Link>
        </nav>
        <div className="topbar-tools">
          <SettingsButton />
          {showIdentity && <IdentityControl />}
        </div>
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
        <div className="home-banner-actions">
          <Link to="/study" className="home-banner-link">
            Study by exam blueprint
          </Link>
          <Link to="/cases" className="home-banner-button">
            Browse practice cases <Mic size={15} aria-hidden="true" />
          </Link>
        </div>
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
            identity. Progress below is built only from what you have done.
          </p>
          <Link className="button button-primary" to="/cases">
            Start an encounter <ArrowRight size={17} />
          </Link>
        </div>
        <ReviewDueNote user={user} />
      </section>
      <ProgressDashboard user={user} />
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
  const filter = useCaseFilters();
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
            <strong>
              {filter.active
                ? `${scenarios.filter(filter.matches).length} of ${scenarios.length}`
                : scenarios.length}
            </strong>
            <span>
              authored cases
              <br />
              {filter.active ? "match these filters" : "ready to practice"}
            </span>
          </div>
        )}
      </section>
      <CaseFilters
        taxonomy={filter.taxonomy}
        failed={filter.taxonomyFailed}
        filters={filter.filters}
        onChange={filter.set}
        onClear={filter.clear}
        active={filter.active}
      />
      {scenarios && filter.active && !scenarios.some(filter.matches) && (
        <div className="study-empty" role="status">
          <p>{filter.emptyMessage}</p>
          <p className="study-muted">
            The library is small and does not cover every blueprint area.
          </p>
        </div>
      )}
      {error && (
        <div className="voice-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      {!scenarios && !error && <div className="loading">Loading cases...</div>}
      <div className="case-grid">
        {scenarios?.filter(filter.matches).map((s) => {
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
/** Rotation and PANCE coverage are public; mixed mode and sprints use the learner's own attempts. */
function StudyPage({
  page,
}: {
  page: "rotation" | "pance" | "mixed" | "sprint";
}) {
  const user = useDevUser();
  if (page === "rotation")
    return (
      <Layout>
        <RotationMode user={user} />
      </Layout>
    );
  if (page === "pance")
    return (
      <Layout>
        <PanceMode user={user} />
      </Layout>
    );
  return (
    <Layout>
      <RequireUser>
        {user &&
          (page === "mixed" ? (
            <MixedMode user={user} />
          ) : (
            <SprintMode user={user} />
          ))}
      </RequireUser>
    </Layout>
  );
}
function Encounter() {
  return (
    <Layout>
      <RequireUser>
        <EncounterPage />
      </RequireUser>
    </Layout>
  );
}
function Results() {
  return (
    <Layout>
      <RequireUser>
        <DebriefPage />
      </RequireUser>
    </Layout>
  );
}
function Review() {
  return (
    <Layout>
      <RequireUser>
        <TodayReview />
      </RequireUser>
    </Layout>
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
      <Route path="/review" element={<Review />} />
      <Route
        path="/study"
        element={
          <Layout>
            <StudyHome />
          </Layout>
        }
      />
      <Route path="/study/rotation" element={<StudyPage page="rotation" />} />
      <Route
        path="/study/rotation/:rotationId"
        element={<StudyPage page="rotation" />}
      />
      <Route path="/study/pance" element={<StudyPage page="pance" />} />
      <Route path="/study/mixed" element={<StudyPage page="mixed" />} />
      <Route path="/study/sprint" element={<StudyPage page="sprint" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
export default App;
