type Props = {
  log: string;
  defaultOpen?: boolean;
};

export function BuildLog({ log, defaultOpen = false }: Props) {
  if (!log.trim()) {
    return null;
  }

  return (
    <details className="build-log" open={defaultOpen}>
      <summary>Build log</summary>
      <pre className="build-log-body">{log}</pre>
    </details>
  );
}
