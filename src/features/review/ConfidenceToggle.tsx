export type Confidence = "sure" | "unsure";

/**
 * Optional, one-tap confidence for the primary diagnosis. Captured before the outcome is known,
 * so it is free of hindsight. Unselected by default; tapping the selected option clears it.
 */
export function ConfidenceToggle({
  value,
  onChange,
  disabled,
}: {
  value: Confidence | null;
  onChange: (next: Confidence | null) => void;
  disabled?: boolean;
}) {
  const option = (id: Confidence, label: string) => (
    <button
      type="button"
      className={`confidence-option ${value === id ? "selected" : ""}`}
      aria-pressed={value === id}
      disabled={disabled}
      onClick={() => onChange(value === id ? null : id)}
    >
      {label}
    </button>
  );
  return (
    <fieldset className="confidence-toggle">
      <legend>
        How sure are you? <small>Optional</small>
      </legend>
      <div className="confidence-options">
        {option("sure", "Sure")}
        {option("unsure", "Unsure")}
      </div>
      <p>It does not change your score. It helps tailor your review afterwards.</p>
    </fieldset>
  );
}
