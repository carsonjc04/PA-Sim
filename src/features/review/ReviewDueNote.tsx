import { ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { ReviewSummary } from "../../api/contracts";

/** Dashboard pointer to Today's review. A count only: no streaks or deadlines. Hidden if unavailable. */
export function ReviewDueNote({ user }: { user: string | null }) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .reviewSummary()
      .then((s) => !cancelled && setSummary(s))
      .catch(() => !cancelled && setSummary(null));
    return () => {
      cancelled = true;
    };
  }, [user]);
  if (!summary) return null;
  return (
    <div className="hero-note review-due-note">
      <ListChecks size={18} className="note-icon" />
      <div>
        <strong>Today&rsquo;s review</strong>
        <p>
          {summary.dueToday > 0
            ? `${summary.dueToday} ${summary.dueToday === 1 ? "item" : "items"} from your past cases.`
            : summary.totalCards > 0
              ? "Nothing due right now."
              : "Misses from submitted cases become short review questions here."}
        </p>
        {summary.dueToday > 0 && (
          <Link className="text-link" to="/review">
            Start reviewing
          </Link>
        )}
      </div>
    </div>
  );
}
