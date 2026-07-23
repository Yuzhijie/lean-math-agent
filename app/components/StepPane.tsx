import type { ProofStep } from "@/lib/types";

type Props = {
  steps: ProofStep[];
  selectedIndex?: number;
  onSelect: (index: number) => void;
};

const STATUS_LABEL: Record<ProofStep["status"], string> = {
  pending: "pending",
  ok: "ok",
  fail: "fail",
};

export function StepPane({ steps, selectedIndex, onSelect }: Props) {
  if (steps.length === 0) {
    return (
      <div className="step-pane">
        <h2 className="pane-title">证明步骤</h2>
        <p className="empty-hint">选择解法并规划后，步骤将显示在此。</p>
      </div>
    );
  }

  return (
    <div className="step-pane">
      <h2 className="pane-title">证明步骤</h2>
      <ul className="step-list">
        {steps.map((step) => {
          const selected = step.index === selectedIndex;
          return (
            <li key={step.index}>
              <button
                type="button"
                className={`step-item${selected ? " selected" : ""}`}
                onClick={() => onSelect(step.index)}
              >
                <div className="step-head">
                  <span className="step-index">#{step.index}</span>
                  <span className={`step-status ${step.status}`}>
                    {STATUS_LABEL[step.status]}
                  </span>
                </div>
                <p className="step-goal">{step.plain_goal}</p>
                {step.plain_explanation ? (
                  <p className="step-explanation">{step.plain_explanation}</p>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
