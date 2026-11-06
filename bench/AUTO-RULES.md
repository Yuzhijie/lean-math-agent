# 自动化策略规则命中率

搜索 2 次，找到证明 2 次（更新于 2026-11-06T00:32:08.146Z）。

| 规则 | 类型 | 说明 | 尝试 | 成功 | 成功率 | 进入证明 | 出现于搜索 |
|---|---|---|---:|---:|---:|---:|---:|
| `false` | 收尾 | ⊢ False: contradiction in the hypotheses | 0 | 0 | — | 0 | 0 |
| `equation` | 收尾 | ⊢ a = b: computation, rings, linear arithmetic, an equation hypothesis | 58 | 0 | 0.0% | 0 | 2 |
| `inequality` | 收尾 | ⊢ a ≤ b, a < b: linear and nonlinear arithmetic, positivity | 0 | 0 | — | 0 | 0 |
| `divides` | 收尾 | ⊢ a ∣ b | 0 | 0 | — | 0 | 0 |
| `not-equal` | 收尾 | ⊢ a ≠ b | 0 | 0 | — | 0 | 0 |
| `other` | 收尾 | any other goal: simplification, propositional logic | 16 | 1 | 6.3% | 1 | 1 |
| `shifted-squares` | 收尾 | nlinarith with (x − k)² ≥ 0 for the statement's small numbers | 2 | 0 | 0.0% | 0 | 1 |
| `definitions` | 收尾 | definitions given as hypotheses ∀ x, f x = …: unfolded | 0 | 0 | — | 0 | 0 |
| `casts` | 收尾 | casts ↑: pushed, an integer unknown computed over ℝ and cast back | 0 | 0 | — | 0 | 0 |
| `definition-instances` | 收尾 | a definition applied to numbers (f 2): its instances as facts | 0 | 0 | — | 0 | 0 |
| `big-operators` | 收尾 | ∑ / ∏ over small ranges written out | 0 | 0 | — | 0 | 0 |
| `digits` | 收尾 | digits / ofDigits | 0 | 0 | — | 0 | 0 |
| `complex` | 收尾 | Complex.I | 0 | 0 | — | 0 | 0 |
| `fractions` | 收尾 | fractions cleared in every hypothesis | 3 | 0 | 0.0% | 0 | 1 |
| `square-roots` | 收尾 | √E² = E and √E ≥ 0 for the roots of the statement | 0 | 0 | — | 0 | 0 |
| `gcd-lcm` | 收尾 | gcd · lcm = the product | 0 | 0 | — | 0 | 0 |
| `two-bounded` | 收尾 | two bounded unknowns: every pair of values | 0 | 0 | — | 0 | 0 |
| `divisibility-bound` | 收尾 | a·n + b ∣ P(n): n bounded through the remainder, then every value (divbound.ts) | 1 | 1 | 100.0% | 1 | 1 |
| `kernel` | 收尾 | closed and finite: the kernel computes it | 0 | 0 | — | 0 | 0 |
| `aesop` | 收尾 | aesop, last | 5 | 0 | 0.0% | 0 | 2 |
| `intro` | 拆分 | binders and hypotheses of the target | 1 | 1 | 100.0% | 1 | 1 |
| `destruct` | 拆分 | ∃ / ∧ (every conjunct at once) / ↔ hypotheses taken apart | 1 | 1 | 100.0% | 1 | 1 |
| `constructor` | 拆分 | ⊢ P ∧ Q, ⊢ P ↔ Q | 1 | 1 | 100.0% | 1 | 1 |
| `or-cases` | 拆分 | a hypothesis P ∨ Q: both cases | 0 | 0 | — | 0 | 0 |
| `interval` | 拆分 | a bounded ℕ / ℤ variable (≤ 40): every value | 0 | 0 | — | 0 | 0 |
| `or-goal` | 拆分 | ⊢ P ∨ Q: either side | 0 | 0 | — | 0 | 0 |
| `witness` | 拆分 | ⊢ ∃ x, …: the statement's numbers, 0, 1, 2, and n, n + 1, 2n | 0 | 0 | — | 0 | 0 |
| `abs` | 拆分 | the first \|…\|: both signs | 0 | 0 | — | 0 | 0 |
| `denominators` | 拆分 | variable denominators shown ≠ 0, then field_simp (the certificate finisher closes the rest) | 1 | 1 | 100.0% | 1 | 1 |
| `rewrite` | 拆分 | definitions unfolded, subst_vars, norm_num / push_cast everywhere | 0 | 0 | — | 0 | 0 |
| `contra` | 拆分 | by_contra + push_neg | 0 | 0 | — | 0 | 0 |
| `certificate` | 收尾 | linear_combination from the polynomial certificate (certificate.ts), after the finishers | 1 | 1 | 100.0% | 1 | 1 |
| `linear-values` | 拆分 | values of the unknowns a linear system fixes (linear.ts), before the splitters | 0 | 0 | — | 0 | 0 |

数据：`.data/auto-rule-stats.json`（本表来自 2 道题的真实 Lean 探测）。新增策略：在 lib/lean/auto/rules.ts 的 BUILTIN_RULES 加一条规则，或写进 .data/auto-rules.json。
