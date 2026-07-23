import type { MethodOption } from "@/lib/types";

type Props = {
  methods: MethodOption[];
  selectedId?: string;
  disabled?: boolean;
  onSelect: (methodId: string) => void;
};

export function MethodList({
  methods,
  selectedId,
  disabled,
  onSelect,
}: Props) {
  if (methods.length === 0) {
    return <p className="empty-hint">枚举解法后将显示方法列表。</p>;
  }

  return (
    <div>
      <h2 className="pane-title">解法</h2>
      <ul className="method-list">
        {methods.map((m) => {
          const selected = m.id === selectedId;
          return (
            <li key={m.id}>
              <button
                type="button"
                className={`method-item${selected ? " selected" : ""}`}
                disabled={disabled}
                onClick={() => onSelect(m.id)}
              >
                <span className="method-item-title">{m.title}</span>
                <span className="method-item-meta">
                  {m.category} · confidence {(m.confidence * 100).toFixed(0)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
