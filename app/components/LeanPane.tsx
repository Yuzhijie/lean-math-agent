type Props = {
  leanSource: string;
  selectedStepCode?: string;
  view: "full" | "step";
  onViewChange: (view: "full" | "step") => void;
};

export function LeanPane({
  leanSource,
  selectedStepCode,
  view,
  onViewChange,
}: Props) {
  const text =
    view === "step"
      ? selectedStepCode?.trim()
        ? selectedStepCode
        : "// 本步尚无 Lean 代码"
      : leanSource.trim()
        ? leanSource
        : "";

  return (
    <div className="lean-pane">
      <h2 className="pane-title">Lean</h2>
      <div className="problem-actions" style={{ marginTop: 0, marginBottom: "0.65rem" }}>
        <button
          type="button"
          className={view === "full" ? "btn" : "btn btn-ghost"}
          onClick={() => onViewChange("full")}
        >
          全文
        </button>
        <button
          type="button"
          className={view === "step" ? "btn" : "btn btn-ghost"}
          onClick={() => onViewChange("step")}
        >
          本步
        </button>
      </div>
      {text ? (
        <pre className="lean-code">{text}</pre>
      ) : (
        <p className="lean-empty">证明步骤后，组装的 Lean 源码将显示在此。</p>
      )}
    </div>
  );
}
