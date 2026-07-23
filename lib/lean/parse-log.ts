export function parseLeanLog(log: string): string {
  const lines = log.split(/\r?\n/);
  const useful = lines.filter(
    (l) => /error:/i.test(l) || /warning:/i.test(l) || /\.lean:\d+:\d+/i.test(l),
  );
  return (useful.length ? useful : lines.slice(-40)).join("\n").trim();
}
