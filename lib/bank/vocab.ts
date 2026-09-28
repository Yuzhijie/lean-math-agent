/**
 * Built-in knowledge-point vocabularies. A bank's own vocabulary (Bank.vocab)
 * is offered first; these are the defaults when it has none.
 *
 * - "au": Australian Curriculum: Mathematics v9 strands with common topics
 *   (fits ICAS-style papers, Years 2–10).
 * - "cn": 义务教育 / 普通高中数学课程标准 content areas with common topics.
 */
export interface VocabGroup {
  strand: string;
  points: string[];
}

export const VOCAB_AU: VocabGroup[] = [
  { strand: "Number", points: ["Place value", "Addition and subtraction", "Multiplication and division", "Fractions", "Decimals", "Percentages", "Ratio and rate", "Integers", "Indices and powers", "Primes, factors and multiples", "Money and financial maths", "Estimation and rounding"] },
  { strand: "Algebra", points: ["Number patterns", "Equations", "Expressions", "Linear relationships", "Inequalities", "Coordinate plane", "Non-linear relationships"] },
  { strand: "Measurement", points: ["Length and perimeter", "Area", "Volume and capacity", "Mass", "Time", "Angles", "Units and conversion", "Scales and maps", "Pythagoras and trigonometry"] },
  { strand: "Space", points: ["2D shapes", "3D objects and nets", "Symmetry", "Transformations", "Location and position", "Grids and directions", "Congruence and similarity"] },
  { strand: "Statistics", points: ["Data displays (graphs and tables)", "Mean, median and mode", "Data interpretation"] },
  { strand: "Probability", points: ["Chance", "Probability of events", "Counting and outcomes"] },
  { strand: "Reasoning", points: ["Logic puzzles", "Spatial reasoning", "Problem solving strategies"] },
];

export const VOCAB_CN: VocabGroup[] = [
  { strand: "数与代数", points: ["整数与四则运算", "分数与小数", "百分数", "比与比例", "有理数", "实数与根式", "整式与因式分解", "分式", "一元一次方程", "二元一次方程组", "一元二次方程", "不等式与不等式组", "函数概念", "一次函数", "反比例函数", "二次函数", "数列", "指数与对数"] },
  { strand: "图形与几何", points: ["线与角", "三角形", "全等三角形", "相似三角形", "勾股定理", "四边形", "圆", "图形的变换", "视图与投影", "坐标与图形", "锐角三角函数", "立体几何", "解析几何", "向量"] },
  { strand: "统计与概率", points: ["数据的收集与整理", "统计图表", "平均数、中位数、众数", "方差", "概率", "排列组合"] },
  { strand: "综合与实践", points: ["应用题", "逻辑推理", "找规律", "行程问题", "工程问题", "鸡兔同笼"] },
];

export function builtinVocab(language: "zh" | "en" | "mixed"): VocabGroup[] {
  return language === "zh" ? VOCAB_CN : language === "en" ? VOCAB_AU : [...VOCAB_CN, ...VOCAB_AU];
}

/** Flat list: the bank's own vocabulary first, then the built-in one. */
export function vocabFor(bank: { vocab: string[]; language: "zh" | "en" | "mixed" }): string[] {
  const out = [...bank.vocab];
  for (const g of builtinVocab(bank.language)) for (const p of g.points) if (!out.includes(p)) out.push(p);
  return out;
}
