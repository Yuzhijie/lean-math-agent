export function DiagramSvg({ svg }: { svg: string }) {
  return (
    <div className="my-3 flex items-center justify-center rounded-lg border border-border/60 bg-white/[0.02] p-3">
      <div
        className="max-w-full [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:max-h-[280px]"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
