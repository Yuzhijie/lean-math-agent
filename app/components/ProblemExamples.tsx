"use client";

import { useI18n } from "@/lib/i18n";
import { Lightbulb } from "lucide-react";
import { MathText } from "./MathText";

/** Example problems shown under an empty (or untouched) problem box: one per kind the solver handles. */
export function ProblemExamples({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }) {
  const { tr } = useI18n();
  const examples: Array<{ kind: string; text: string }> = [
    {
      kind: tr("计算", "Compute"),
      text: tr("解方程组：$2x + 3y = 12$，$x - y = 1$。", "Solve the system $2x + 3y = 12$, $x - y = 1$."),
    },
    {
      kind: tr("几何", "Geometry"),
      text: tr(
        "在直角三角形 $ABC$ 中，$\\angle C = 90^\\circ$，$AC = 6$，$BC = 8$。求斜边 $AB$ 上的高。",
        "In right triangle $ABC$, $\\angle C = 90^\\circ$, $AC = 6$ and $BC = 8$. Find the altitude to the hypotenuse $AB$.",
      ),
    },
    {
      kind: tr("证明", "Proof"),
      text: tr("证明：对任意整数 $n$，$n^2 + n$ 是偶数。", "Prove that $n^2 + n$ is even for every integer $n$."),
    },
    {
      kind: tr("最值", "Optimize"),
      text: tr("已知正数 $a, b$ 满足 $a + b = 4$，求 $ab$ 的最大值。", "Positive numbers $a$ and $b$ satisfy $a + b = 4$. Find the largest value of $ab$."),
    },
    {
      kind: tr("应用题", "Word problem"),
      text: tr(
        "Mia 有 24 颗糖。她把其中的 $\\frac{3}{8}$ 给了弟弟，自己又吃了 4 颗。她还剩多少颗糖？",
        "Mia has 24 sweets. She gives $\\frac{3}{8}$ of them to her brother and then eats 4. How many sweets does she have left?",
      ),
    },
  ];
  return (
    <div className="space-y-1.5" data-testid="problem-examples">
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Lightbulb className="h-3 w-3" />
        {tr("试试这些例题，或粘贴 / 拖入一张题目图片：", "Try an example, or paste / drop a picture of a problem:")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {examples.map((e) => (
          <button
            key={e.kind}
            type="button"
            disabled={disabled}
            onClick={() => onPick(e.text)}
            title={e.text}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-40"
          >
            <span className="font-medium text-primary">{e.kind}</span>
            <span className="max-w-[18rem] truncate">
              <MathText text={e.text} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
