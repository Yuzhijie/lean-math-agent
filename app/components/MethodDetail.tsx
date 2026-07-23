import type { MethodOption } from "@/lib/types";

type Props = {
  method?: MethodOption;
  comparisonSummary?: string;
};

export function MethodDetail({ method, comparisonSummary }: Props) {
  if (!method) {
    return (
      <div className="method-detail">
        <h2 className="pane-title">灵感与权衡</h2>
        <p className="empty-hint">选择一种解法以查看灵感、优缺点与草图。</p>
        {comparisonSummary ? (
          <p className="comparison">{comparisonSummary}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="method-detail">
      <h2 className="pane-title">灵感与权衡</h2>
      <h3>{method.title}</h3>
      <dl>
        <dt>Inspiration</dt>
        <dd>{method.inspiration}</dd>
        <dt>Pros</dt>
        <dd>{method.pros}</dd>
        <dt>Cons</dt>
        <dd>{method.cons}</dd>
        <dt>Lean sketch</dt>
        <dd>
          <pre className="lean-code" style={{ maxHeight: "10rem" }}>
            {method.lean_sketch}
          </pre>
        </dd>
      </dl>
      {comparisonSummary ? (
        <p className="comparison">{comparisonSummary}</p>
      ) : null}
    </div>
  );
}
