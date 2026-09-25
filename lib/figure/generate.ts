/**
 * Generate a figure for a problem (and its solution): the model writes a
 * FigureSpec, the solver computes coordinates, the checker verifies the
 * problem's conditions. When the spec cannot be built, or conditions fail,
 * the errors go back to the model once for a corrected spec; the better
 * of the two attempts is kept.
 */
import { chatJson } from "../llm/client";
import type { NaturalLanguageSolution } from "../types";
import { buildFigure } from "./check";
import { FigureError } from "./solve";
import { figureSpecSchema, type FigureSpec, type SolvedFigure } from "./spec";

export const FIGURE_SYSTEM = `你为中小学数学题配图。你不画图、不写坐标计算，只输出一份 JSON「图形描述」，由程序计算坐标并校验题目条件。

输出 JSON 字段：
- needed: 是否需要配图。纯代数、数论且无几何/函数背景、也不是逻辑推理/集合/排队/搭配计数题时为 false，其余字段可省略。
- title: 图的简短标题（可选）。
- constructions: 按作图顺序构造点和圆（后面的构造只能引用前面已定义的点）。op 取值：
  - {"op":"triangle","ids":["A","B","C"],"sides":{"AB":5,"BC":6},"angles":{"A":90},"isosceles_at":"A","equilateral":false} —— 给出题目中的边长（以两顶点命名）和角度（度，以顶点命名），缺省的由程序补成示意图。
  - {"op":"rectangle","ids":["A","B","C","D"],"width":4,"height":3} / {"op":"square","ids":[...4],"side":2} / {"op":"parallelogram","ids":[...4],"ab":5,"ad":3,"angle":60} / {"op":"regular_polygon","ids":[...],"side":2}
  - {"op":"point","id":"P","x":1,"y":2} —— 仅用于坐标题或题目给出坐标时。
  - {"op":"midpoint","id":"M","of":["B","C"]}、{"op":"point_on_segment","id":"E","of":["A","B"],"ratio":0.25}（AE:AB）
  - {"op":"foot","id":"H","from":"A","line":["B","C"]}（垂足）、{"op":"intersection","id":"O","line1":["A","C"],"line2":["B","D"]}
  - {"op":"angle_bisector_point","id":"D","vertex":"A","from":"B","to":"C"}（∠BAC 的平分线交 BC 于 D）
  - {"op":"reflect","id":"P'","of":"P","over":["A","B"]}、{"op":"rotate","id":"B'","of":"B","center":"A","angle":90}（逆时针，度）
  - {"op":"circle","id":"c1","center":"O","radius":3} 或 "through":"A"；{"op":"circumcircle","id":"c","of":["A","B","C"],"center_id":"O"}；{"op":"incircle","id":"c","of":["A","B","C"],"center_id":"I"}
  - {"op":"point_on_circle","id":"P","circle":"c","angle":120}、{"op":"line_circle_intersection","id":"E","line":["A","M"],"circle":"c","which":0}
  - {"op":"function_point","id":"P","fn":"f","x":2}（函数图像上的点）
- draw: 需要画出的附加元素（构造出的多边形、圆、函数会自动画出，不必重复）：
  - {"type":"segment","a":"A","b":"D","id":"AD","dashed":true,"label":"4"} —— 辅助线用 dashed:true
  - {"type":"line","a":..,"b":..} / {"type":"ray",...} / {"type":"polygon","ids":[...],"fill":true}
  - {"type":"angle","vertex":"B","from":"A","to":"C","label":"60°","right":false,"id":"angB"}
  - {"type":"equal_marks","segments":[["A","B"],["A","C"]],"count":1} / {"type":"text","at":"P","text":"起点"} / {"type":"circle","circle":"c","dashed":true}
- claims: 题目给出的条件（程序会逐条数值校验，写全）：perpendicular {"lines":[["A","D"],["B","C"]]}、parallel、equal_length {"segments":[..]}、length {"segment":["A","B"],"value":5}、angle {"points":["A","B","C"],"value":60}（∠ABC）、collinear {"points":[...]}、on_circle {"point":"P","circle":"c"}、concyclic {"points":[4 个]}、function_passes {"fn":"f","x":1,"y":0}。
- axes: 坐标系范围，函数/坐标题必填，如 {"x":[-4,6],"y":[-5,5],"grid":true}；范围要包含所有关键点（零点、顶点、交点）。
- functions: [{"id":"f","expr":"x^2-2x-3","label":"y=x²-2x-3","domain":[-2,4]}]，expr 只用 x、数字、+ - * / ^、括号、|x|、sin cos tan sqrt ln log exp、pi。
- hidden_points: 构造用但不显示的点。
- step_highlights: 解答第几步（从 1 开始）要突出哪些元素：[{"step":2,"ids":["AD","D","angB"]}]；元素用点名、线段名（两端点名相连，如 "AD"）、draw 项的 id、圆 id、函数 id。

- logic: 逻辑题图示（逻辑推理、集合计数、排队座位、搭配计数题用它；此时 constructions/draw/claims 留空数组，不要 axes）。程序会穷举求解、检查答案是否唯一且正确，再画图。四种之一：
  - 对应推理（甲乙丙分别是…）→ 表格法：{"type":"grid","categories":[{"name":"人","items":["甲","乙","丙"]},{"name":"职业","items":["医生","教师","律师"]}],"constraints":[{"type":"is_not","a":"甲","b":"医生"},{"type":"is","a":"乙","b":"律师"},{"type":"one_of","a":"丙","options":["医生","教师"]}],"answer":{"甲":["教师"],"乙":["律师"],"丙":["医生"]}}。第一类是行（通常是人），每类项数相同；约束可跨任意两类（如 {"type":"is","a":"医生","b":"北京"}）。无法用 is/is_not/one_of 表达的条件（如"比…年龄大"、说真话假话）写进 "unencoded":["原文条件"]，不要硬编。
  - 集合计数（喜欢…的有…人，两样都…）→ 韦恩图：{"type":"venn","sets":[{"id":"A","label":"语文","total":25},{"id":"B","label":"数学","total":30}],"intersections":[{"sets":["A","B"],"count":12}],"universe":50,"ask":"neither","answer":7,"universe_label":"全班"}。total/count 都是"包含"的人数（喜欢语文的 25 人含两样都喜欢的）；neither=都不…的人数，union=至少一样的人数；ask 取 "A∩B"、"A∪B"、"A"、"only A"、"neither"、"exactly one"、"exactly two" 等。
  - 排队、座位（排成一排、围坐一圈、相邻、左边）→ {"type":"ordering","layout":"row","items":["A","B","C","D"],"constraints":[{"type":"position","a":"A","pos":1},{"type":"adjacent","a":"B","b":"C"},{"type":"left_of","a":"C","b":"D"}],"answer":["A","B","C","D"],"ends":["左","右"]}。约束：position/not_position(pos 从 1 起，row 从左数)、left_of、immediately_left_of、adjacent、not_adjacent、between{a,b,c}(a 在 b、c 之间)、at_end、not_at_end、opposite(圆桌正对)。layout:"circle" 时 answer 按顺时针。问"有多少种排法"时不写 answer，写 "count":种数。
  - 搭配、有多少种（树状图）→ {"type":"tree","levels":[{"label":"上衣","options":["红","蓝"]},{"label":"裤子","options":["黑","白","灰"]}],"answer":6}；从同一组里选且不能重复时 levels 各层写同一组并加 "distinct":true；禁止的组合写 "exclude":[["红","白"]]。
  逻辑题中项名须唯一（2–12 字），step_highlights 的 ids 用项名（如 "甲"、"医生"），韦恩图用区域名 "A"、"B"、"AB"、"none"。

要求：
1. 忠实于题目：题目给出的长度、角度、垂直、平行、中点、相切等条件都要体现在 constructions 或 claims 里。
2. 求证/求解的结论不要作为已知条件写进 constructions（可以写进 claims，程序会检查图是否符合）。
3. 点名与题目一致（A、B、C、D、O、P …）。
4. 只输出 JSON。

示例（等腰三角形 ABC 中 AB=AC=5，BC=6，AD⊥BC 于 D，求 AD）：
{"needed":true,"title":"等腰三角形 ABC","constructions":[{"op":"triangle","ids":["A","B","C"],"sides":{"AB":5,"AC":5,"BC":6},"isosceles_at":"A"},{"op":"foot","id":"D","from":"A","line":["B","C"]}],"draw":[{"type":"segment","a":"A","b":"D","id":"AD","dashed":true},{"type":"angle","vertex":"D","from":"A","to":"C","right":true},{"type":"equal_marks","segments":[["A","B"],["A","C"]]}],"claims":[{"type":"perpendicular","lines":[["A","D"],["B","C"]]},{"type":"length","segment":["A","B"],"value":5}],"step_highlights":[{"step":1,"ids":["AD","D"]}]}

示例（二次函数 y=x²-2x-3 与 x 轴交于 A、B，顶点 P）：
{"needed":true,"axes":{"x":[-3,5],"y":[-5,6],"grid":true},"functions":[{"id":"f","expr":"x^2-2x-3","label":"y=x²-2x-3"}],"constructions":[{"op":"function_point","id":"A","fn":"f","x":-1},{"op":"function_point","id":"B","fn":"f","x":3},{"op":"function_point","id":"P","fn":"f","x":1}],"claims":[{"type":"function_passes","fn":"f","x":-1,"y":0},{"type":"function_passes","fn":"f","x":3,"y":0}],"step_highlights":[{"step":2,"ids":["P"]}]}

示例（甲、乙、丙三人分别是医生、教师、律师。甲不是医生，乙是律师。）：
{"needed":true,"title":"推理表","constructions":[],"draw":[],"claims":[],"logic":{"type":"grid","categories":[{"name":"人","items":["甲","乙","丙"]},{"name":"职业","items":["医生","教师","律师"]}],"constraints":[{"type":"is_not","a":"甲","b":"医生"},{"type":"is","a":"乙","b":"律师"}],"answer":{"甲":["教师"],"乙":["律师"],"丙":["医生"]}},"step_highlights":[{"step":1,"ids":["乙","律师"]},{"step":2,"ids":["甲","医生"]}]}`;

/**
 * Cheap pre-filter: skip the LLM call for problems with no geometric or
 * graphical content. Errs on the side of trying.
 */
export function mightNeedFigure(problemText: string): boolean {
  return /三角形|四边形|多边形|平行四边形|矩形|长方形|正方形|菱形|梯形|圆|弧|弦|切线|半径|直径|角|垂直|垂足|平行|中点|中线|高线|平分线|线段|射线|直线|对称|旋转|翻折|折叠|坐标|函数|图像|图象|抛物线|双曲线|椭圆|x\s*轴|y\s*轴|数轴|面积|周长|体积|棱|正方体|长方体|圆柱|圆锥|球|向量|△|∠|⊥|∥|⊙|内心|外心|重心|垂心|内切|外接|分别是|分别为|说谎|说真话|说假话|真话|假话|排成一[排行列]|排队|站成|座位|围坐|圆桌|相邻|挨着|左边|右边|喜欢|参加|都不|两[样项种]都|既.{1,8}又|有多少种|多少种不同|搭配|树状图|推理|职业|甲.{0,6}乙.{0,6}丙|\\(?:angle|triangle|odot|perp|parallel|overline|widehat|sqrt\{[^}]*\}\s*x)|triangle|circle|angle|graph|parabola|perpendicular|parallel/i.test(
    problemText,
  );
}

export interface FigureResult {
  figure?: SolvedFigure;
  /** Why no figure was produced ("not_needed", or an error message). */
  reason?: string;
  attempts: number;
}

function solutionText(nl?: NaturalLanguageSolution): string | undefined {
  if (!nl) return undefined;
  const steps = nl.steps.map((s, i) => `${i + 1}. ${s.title}：${s.content}`.slice(0, 400));
  return [nl.summary, ...steps, `答案：${nl.final_answer}`].join("\n").slice(0, 3500);
}

function tryBuild(spec: FigureSpec): { figure?: SolvedFigure; error?: string } {
  try {
    return { figure: buildFigure(spec) };
  } catch (e) {
    return { error: e instanceof FigureError || e instanceof Error ? e.message : String(e) };
  }
}

export async function generateFigure(args: {
  problemText: string;
  solution?: NaturalLanguageSolution;
  /** Skip the keyword pre-filter. */
  force?: boolean;
}): Promise<FigureResult> {
  if (!args.force && !mightNeedFigure(args.problemText)) return { reason: "not_needed", attempts: 0 };
  const sol = solutionText(args.solution);
  const user = `题目：\n${args.problemText}${sol ? `\n\n解答（步骤编号用于 step_highlights）：\n${sol}` : ""}\n\n请输出图形描述 JSON。`;

  const first = await chatJson<FigureSpec>({
    system: FIGURE_SYSTEM,
    user,
    schema: figureSpecSchema,
    schemaName: "figureSpec",
    temperature: 0.2,
    maxTokens: 3000,
  });
  if (!first.needed) return { reason: "not_needed", attempts: 1 };
  const a = tryBuild(first);
  if (a.figure?.verified) return { figure: a.figure, attempts: 1 };

  // One repair round with the solver/checker feedback.
  const problems = a.error
    ? `程序无法按描述作图：${a.error}`
    : `作图后以下条件不成立：\n${a.figure!.claims.filter((c) => !c.ok).map((c) => `- ${c.detail}`).join("\n")}`;
  let second: FigureSpec | undefined;
  try {
    second = await chatJson<FigureSpec>({
      system: FIGURE_SYSTEM,
      user: `${user}\n\n你上一次的描述：\n${JSON.stringify(first)}\n\n${problems}\n\n请修正后输出完整的图形描述 JSON（检查构造顺序、边角数据和条件是否与题目一致）。`,
      schema: figureSpecSchema,
      schemaName: "figureSpec",
      temperature: 0.2,
      maxTokens: 3000,
    });
  } catch {
    second = undefined;
  }
  const b = second && second.needed ? tryBuild(second) : undefined;
  const score = (f?: SolvedFigure) => (f ? f.claims.filter((c) => c.ok).length - 10 * f.claims.filter((c) => !c.ok).length : -Infinity);
  const best = score(b?.figure) > score(a.figure) ? b?.figure : a.figure;
  if (best) return { figure: best, attempts: 2 };
  return { reason: b?.error ?? a.error ?? "无法作图", attempts: 2 };
}
