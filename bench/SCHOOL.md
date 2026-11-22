# bench/school.json 的回归（真实 Lean，不调模型）

由 `npm run lean:regress` 生成（2026-11-22 11:24 UTC）。清单 `bench/school.json`（school-v1）里有 152 条陈述：小学和初中各类题型的陈述（按形式化会写出的样子），每条记着不调模型的流程里由哪条路线证出。`npm run lean:regress -- --file bench/school.json --out bench/SCHOOL.md`。for = 学段/题型。 脚本用产品自己的不调模型的流程（自动化 → 乘法阶 → 逐个检查 → 几何 → 归纳 → 优化 → 组合 → 策略搜索）在真实的 Lean 里重跑一遍。

- **通过** = 仍由记录的那条路线证出。**换了路线** = 证出了，但不是原来那条（通常是前面的路线变强了；也可能是原来的证明器坏了、后面的路线接住了，值得看一眼）。**没证出** = 退化。
- 什么时候跑：升级沙箱的 Mathlib 之前和之后各一次；改动某个证明器之后（`--only geometry`）。日常用 `--quick`（跳过要几分钟的用例）。
- 用时只在同一台机器的两次运行之间比较。

## 历次运行

| 运行 | 机器 | Lean / Mathlib | 用例 | 通过 | 换了路线 | 没证出 | 不该证却证了 | 出错 | 用时 | 提交 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-22 10:23 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 101 | 89 | 0 | 12 | 0 | 0 | 7.0 分钟 | `b7d3241` |
| 2026-11-22 10:37 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 12 | 11 | 0 | 1 | 0 | 0 | 2.6 分钟 | `b7d3241` |
| 2026-11-22 10:44 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 2 | 2 | 0 | 0 | 0 | 0 | 58 秒 | `b7d3241` |
| 2026-11-22 10:47 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 152 | 151 | 0 | 1 | 0 | 0 | 8.1 分钟 | `b7d3241` |
| 2026-11-22 10:57 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 1 | 0 | 0 | 1 | 0 | 0 | 85 秒 | `b7d3241` |
| 2026-11-22 11:00 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 1 | 1 | 0 | 0 | 0 | 0 | 31 秒 | `b7d3241` |
| 2026-11-22 11:01 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 152 | 152 | 0 | 0 | 0 | 0 | 6.7 分钟 | `b7d3241` |

## 最近一次运行：2026-11-22 11:01

152 条用例：152 条通过，0 条换了路线，0 条没证出，0 条不该证出却证出了，0 条运行出错。**没有退化。**

### 按证明器

| 为哪个证明器而写 | 用例 | 通过 | 换了路线 | 没通过 | 总用时 | 最慢的一条 |
| --- | --- | --- | --- | --- | --- | --- |
| primary | 58 | 58 | 0 | 0 | 86 秒 | p-concentration（30 秒） |
| middle | 94 | 94 | 0 | 0 | 5.3 分钟 | m-abs-equation（37 秒） |

### 时间花在哪一级

每条陈述按顺序过这些阶段（`lib/lean/prover-stages.ts`），第一个证出的就停。152 条有分阶段记录：各阶段合计 6.7 分钟，其中 2.7 分钟（40%）花在没证出的阶段上。

| 阶段 | 跑了 | 证出 | 证出的用时 | 没证出的用时 | 最慢的一次没证出 | 总时间用完没跑 |
| --- | --- | --- | --- | --- | --- | --- |
| hammer | 152 | 96 | 69 秒 | 100 秒 | p-concentration（27 秒） | 0 |
| trivial | 43 | 0 | 0.0 秒 | 57 秒 | m-quadratic-iff（3.6 秒） | 0 |
| geometry | 15 | 12 | 28 秒 | 3.4 秒 | m-trig-expr（3.0 秒） | 0 |
| induction | 1 | 1 | 0.7 秒 | 0.0 秒 | — | 0 |
| inequality | 8 | 1 | 1.7 秒 | 1.6 秒 | m-parabola-bound（0.5 秒） | 0 |
| combinatorics | 1 | 0 | 0.0 秒 | 0.6 秒 | p-pigeonhole（0.6 秒） | 0 |
| auto | 42 | 42 | 2.4 分钟 | 0.0 秒 | — | 0 |

### 与上一次（2026-11-22 11:00）相比

两次都跑过的 1 条：丢掉 0 条，新证出 0 条，路线变了 0 条。

总用时 31 秒 → 3.4 秒。变慢一倍以上（且多出半分钟）的 0 条；快了一倍以上的 0 条。

### 全部用例

| 用例 | 为它而写 | 结果 | 路线 | 用时 | 上次 | 是什么 |
| --- | --- | --- | --- | --- | --- | --- |
| p-calc-distributive | primary/计算 | ✓ | hammer | 0.3 秒 | — | 简便运算：36×24 + 36×76 = 3600 |
| p-calc-decimal | primary/计算 | ✓ | hammer | 0.4 秒 | — | 小数乘法：3.6×2.5 + 1.25×8 = 19 |
| p-calc-fraction | primary/计算 | ✓ | hammer | 0.3 秒 | — | 分数加减：2/3 + 3/4 − 5/6 = 7/12 |
| p-calc-mixed | primary/计算 | ✓ | hammer | 0.3 秒 | — | 带括号的四则混合运算 |
| p-frac-compare | primary/计算 | ✓ | hammer | 0.3 秒 | — | 分数比较大小：5/7 < 8/11 |
| p-percent | primary/百分数 | ✓ | hammer | 0.7 秒 | — | 打七五折：240 元的 75% 是 180 元 |
| p-profit | primary/百分数 | ✓ | hammer | 0.8 秒 | — | 成本 c，加价 40% 后打八折，获利 24 元 ⇒ c = 200 |
| p-concentration | primary/百分数 | ✓ | auto | 30 秒 | — | 200 克 10% 的盐水加盐 x 克变成 20% ⇒ x = 25 |
| p-divmod | primary/数论 | ✓ | hammer | 0.3 秒 | — | 带余除法：2025 ÷ 7 = 289 余 2 |
| p-gcd-lcm | primary/数论 | ✓ | hammer | 0.3 秒 | — | 84 和 126 的最大公因数 42、最小公倍数 252 |
| p-divisors | primary/数论 | ✓ | hammer | 0.6 秒 | — | 360 有 24 个因数 |
| p-primes-100 | primary/数论 | ✓ | hammer | 3.1 秒 | — | 100 以内有 25 个质数 |
| p-factorize | primary/数论 | ✓ | hammer | 0.4 秒 | — | 分解质因数：360 = 2³ × 3² × 5 |
| p-last-digit | primary/数论 | ✓ | hammer | 0.4 秒 | — | 周期问题：7^2025 的个位数字是 7 |
| p-multiples | primary/数论 | ✓ | hammer | 0.5 秒 | — | 1 到 100 中 3 或 5 的倍数有 47 个 |
| p-remainder | primary/数论 | ✓ | hammer | 1.4 秒 | — | 除以 3 余 2、除以 5 余 3、除以 7 余 2 的最小正整数是 23（韩信点兵） |
| p-chicken-rabbit | primary/应用题 | ✓ | hammer | 0.6 秒 | — | 鸡兔同笼：35 个头 94 只脚 ⇒ 鸡 23、兔 12 |
| p-sum-multiple | primary/应用题 | ✓ | hammer | 0.4 秒 | — | 和倍问题：和 120，甲是乙的 3 倍 |
| p-sum-difference | primary/应用题 | ✓ | hammer | 0.5 秒 | — | 和差问题：和 86，差 12 |
| p-age | primary/应用题 | ✓ | hammer | 0.5 秒 | — | 年龄问题：父亲是儿子的 4 倍，20 年后是 2 倍 |
| p-meeting | primary/应用题 | ✓ | hammer | 0.8 秒 | — | 相遇问题：相距 420 千米，速度 60 和 80 ⇒ 3 小时 |
| p-chase | primary/应用题 | ✓ | hammer | 0.8 秒 | — | 追及问题：先走 2 小时，速度 60 和 75 ⇒ 8 小时追上 |
| p-work | primary/应用题 | ✓ | hammer | 1.4 秒 | — | 工程问题：甲 12 天、乙 18 天，合作 36/5 天 |
| p-surplus | primary/应用题 | ✓ | hammer | 0.6 秒 | — | 盈亏问题：每人 5 个多 12 个，每人 7 个少 8 个 ⇒ 10 人 62 个 |
| p-trees | primary/应用题 | ✓ | hammer | 0.4 秒 | — | 植树问题：100 米每 5 米一棵，两端都种 ⇒ 21 棵 |
| p-ratio | primary/应用题 | ✓ | auto | 5.5 秒 | — | 按比分配：三个角的比 2:3:4，和 180° |
| p-average | primary/统计 | ✓ | hammer | 0.4 秒 | — | 五次成绩的平均数是 88 |
| p-series-100 | primary/数列 | ✓ | hammer | 0.4 秒 | — | 1 + 2 + … + 100 = 5050 |
| p-series-odd | primary/数列 | ✓ | hammer | 0.4 秒 | — | 前 50 个奇数的和是 2500 |
| p-sequence-term | primary/数列 | ✓ | hammer | 0.5 秒 | — | 等差数列：首项 3、公差 4，第 10 项是 39 |
| p-new-operation | primary/计算 | ✓ | hammer | 0.4 秒 | — | 定义新运算 a※b = 3a + 2b，(1※2)※3 = 27 |
| p-digits | primary/数论 | ✓ | hammer | 0.5 秒 | — | 两位数与它的倒序数之和是 121 ⇒ 数字和 11 |
| p-rect | primary/图形 | ✓ | hammer | 2.2 秒 | — | 长方形周长 36，长是宽的 2 倍 ⇒ 面积 72 |
| p-trapezoid | primary/图形 | ✓ | hammer | 0.4 秒 | — | 梯形面积：(6 + 10) × 5 ÷ 2 = 40 |
| p-circle | primary/图形 | ✓ | auto | 5.1 秒 | — | 圆周长 12π ⇒ 面积 36π |
| p-cylinder | primary/图形 | ✓ | hammer | 0.4 秒 | — | 圆柱体积：π × 3² × 10 = 90π |
| p-max-area | primary/图形 | ✓ | hammer | 0.9 秒 | — | 周长一定的长方形，正方形面积最大：l + w = 10 ⇒ lw ≤ 25 |
| p-handshake | primary/计数 | ✓ | hammer | 0.3 秒 | — | 10 个人两两握手 45 次 |
| p-arrange | primary/计数 | ✓ | hammer | 0.4 秒 | — | 4 个人排成一排有 24 种排法 |
| p-three-digit | primary/计数 | ✓ | hammer | 2.2 秒 | — | 用 0–4 组成没有重复数字的三位数有 48 个 |
| p-pigeonhole | primary/计数 | ✓ | auto | 5.5 秒 | — | 抽屉原理：13 个人中必有两人生日在同一个月 |
| p-diophantine | primary/应用题 | ✓ | hammer | 2.5 秒 | — | 3 元和 5 元的邮票凑 47 元有 3 种买法 |
| m-signed | middle/有理数 | ✓ | hammer | 0.3 秒 | — | 有理数混合运算：(−3)² − 4×(−2) + \|−5\| = 22 |
| m-power | middle/有理数 | ✓ | hammer | 0.5 秒 | — | 幂的运算：2¹⁰ × 2⁻⁸ = 4 |
| m-linear | middle/方程 | ✓ | hammer | 0.8 秒 | — | 一元一次方程：3(x − 2) + 5 = 2x + 7 ⇒ x = 8 |
| m-linear-frac | middle/方程 | ✓ | hammer | 1.0 秒 | — | 去分母：(x + 1)/2 − (2x − 1)/3 = 1 ⇒ x = −1 |
| m-system-2 | middle/方程 | ✓ | auto | 3.2 秒 | — | 二元一次方程组：2x + 3y = 12，x − y = 1 |
| m-system-3 | middle/方程 | ✓ | auto | 3.8 秒 | — | 三元一次方程组 |
| m-quadratic | middle/方程 | ✓ | auto | 2.8 秒 | — | 一元二次方程：x² − 5x + 6 = 0 ⇒ x = 2 或 x = 3 |
| m-quadratic-set | middle/方程 | ✓ | auto | 19 秒 | — | 一元二次方程的解集 {2, 3} |
| m-quadratic-surd | middle/方程 | ✓ | auto | 3.5 秒 | — | 求根公式：x² − 2x − 1 = 0 ⇒ x = 1 ± √2 |
| m-quadratic-none | middle/方程 | ✓ | hammer | 0.9 秒 | — | 判别式小于 0：x² + x + 1 = 0 没有实数根 |
| m-discriminant | middle/方程 | ✓ | auto | 5.2 秒 | — | x² − 4x + k = 0 有两个相等的实数根 ⇒ k = 4 |
| m-vieta | middle/方程 | ✓ | auto | 4.2 秒 | — | 根与系数的关系：x₁ + x₂ = 5，x₁x₂ = 3 ⇒ x₁² + x₂² = 19 |
| m-frac-equation | middle/方程 | ✓ | auto | 4.3 秒 | — | 分式方程：3/(x − 2) = 1 ⇒ x = 5 |
| m-growth | middle/方程 | ✓ | hammer | 1.9 秒 | — | 增长率：100(1 + x)² = 121 ⇒ x = 10% |
| m-abs-equation | middle/方程 | ✓ | auto | 37 秒 | — | 绝对值方程：\|x − 3\| = 5 ⇒ x = 8 或 x = −2 |
| m-inequality | middle/不等式 | ✓ | auto | 4.3 秒 | — | 一元一次不等式：2x − 3 < 5 ⇔ x < 4 |
| m-inequality-system | middle/不等式 | ✓ | auto | 7.5 秒 | — | 不等式组的解集 1 < x ≤ 4 |
| m-inequality-integers | middle/不等式 | ✓ | hammer | 0.6 秒 | — | 不等式组的整数解有 3 个 |
| m-abs-inequality | middle/不等式 | ✓ | auto | 2.5 秒 | — | \|x − 1\| < 2 ⇔ −1 < x < 3 |
| m-factor | middle/代数式 | ✓ | hammer | 0.4 秒 | — | 因式分解：x³ − x = x(x − 1)(x + 1) |
| m-identity | middle/代数式 | ✓ | hammer | 0.4 秒 | — | (a + b)² − (a − b)² = 4ab |
| m-value-sym | middle/代数式 | ✓ | hammer | 1.8 秒 | — | a + b = 5，ab = 6 ⇒ a² + b² = 13 |
| m-value-recip | middle/代数式 | ✓ | auto | 6.3 秒 | — | x + 1/x = 3 ⇒ x² + 1/x² = 7 |
| m-frac-simplify | middle/代数式 | ✓ | hammer | 0.7 秒 | — | 分式化简：(x² − 1)/(x − 1) − x = 1 |
| m-surd-add | middle/二次根式 | ✓ | geometry | 5.7 秒 | — | √12 + √27 = 5√3 |
| m-surd-simplify | middle/二次根式 | ✓ | geometry | 2.1 秒 | — | √50 = 5√2 |
| m-surd-product | middle/二次根式 | ✓ | geometry | 1.4 秒 | — | (√3 + 1)(√3 − 1) = 2 |
| m-surd-rationalize | middle/二次根式 | ✓ | geometry | 2.2 秒 | — | 分母有理化：1/(√2 − 1) = √2 + 1 |
| m-irrational | middle/二次根式 | ✓ | hammer | 0.3 秒 | — | √2 是无理数 |
| m-linear-function | middle/函数 | ✓ | auto | 3.0 秒 | — | 一次函数过 (1, 3) 和 (3, 7) ⇒ k = 2，b = 1 |
| m-inverse-function | middle/函数 | ✓ | hammer | 1.1 秒 | — | 反比例函数过 (2, 3) ⇒ x = −3 时 y = −2 |
| m-parabola-coeffs | middle/函数 | ✓ | auto | 4.7 秒 | — | 抛物线过 (0, 3)、(1, 0)、(3, 0) ⇒ y = x² − 4x + 3 |
| m-parabola-min | middle/函数 | ✓ | auto | 1.9 秒 | — | 二次函数 y = x² − 4x + 7 的最小值是 3 |
| m-parabola-bound | middle/函数 | ✓ | auto | 8.1 秒 | — | x² − 4x + 7 ≥ 3 |
| m-parabola-max | middle/函数 | ✓ | auto | 3.3 秒 | — | 利润 y = −2x² + 120x − 1000 的最大值是 800（x = 30） |
| m-pythagoras | middle/几何 | ✓ | hammer | 1.2 秒 | — | 勾股定理：直角边 3 和 4 ⇒ 斜边 5 |
| m-distance | middle/几何 | ✓ | hammer | 0.4 秒 | — | 两点 (1, 2)、(4, 6) 的距离是 5 |
| m-similar | middle/几何 | ✓ | hammer | 0.8 秒 | — | 相似三角形对应边成比例：x/6 = 4/8 ⇒ x = 3 |
| m-angle-sum | middle/几何 | ✓ | hammer | 0.8 秒 | — | 三角形内角和：∠A = 2∠B，∠C = ∠B + 20° ⇒ ∠B = 40° |
| m-polygon | middle/几何 | ✓ | hammer | 0.4 秒 | — | 内角和 1080° 的多边形是八边形 |
| m-sector | middle/几何 | ✓ | hammer | 0.5 秒 | — | 半径 6、圆心角 120° 的扇形面积 12π |
| m-trig-values | middle/几何 | ✓ | hammer | 0.4 秒 | — | 特殊角：sin 30° + cos 60° = 1 |
| m-trig-tan | middle/几何 | ✓ | hammer | 0.4 秒 | — | tan 45° = 1 |
| m-trig-expr | middle/几何 | ✓ | auto | 12 秒 | — | 2 sin 60° − tan 45° + √3 cos 30° = √3 + 1/2 |
| m-midline | middle/几何证明 | ✓ | hammer | 0.7 秒 | — | 三角形中位线平行于第三边且等于它的一半（坐标） |
| m-median-hypotenuse | middle/几何证明 | ✓ | geometry | 6.3 秒 | — | 直角三角形斜边上的中线等于斜边的一半（坐标） |
| m-parallelogram | middle/几何证明 | ✓ | geometry | 3.0 秒 | — | 平行四边形的对角线互相平分（坐标） |
| m-isosceles | middle/几何证明 | ✓ | geometry | 2.4 秒 | — | 等腰三角形底边上的中线垂直于底边（坐标） |
| m-probability | middle/概率统计 | ✓ | hammer | 0.5 秒 | — | 掷两枚骰子点数和为 7 的概率是 1/6 |
| m-variance | middle/概率统计 | ✓ | hammer | 0.4 秒 | — | 数据 2, 3, 4, 5, 6 的方差是 2 |
| m-even | middle/代数证明 | ✓ | auto | 2.3 秒 | — | n² + n 是偶数 |
| m-div6 | middle/代数证明 | ✓ | auto | 3.2 秒 | — | 三个连续整数的积能被 6 整除：6 ∣ n³ − n |
| m-div3 | middle/代数证明 | ✓ | induction | 2.9 秒 | — | 3 ∣ n³ + 2n |
| m-odd-square | middle/代数证明 | ✓ | hammer | 0.6 秒 | — | 奇数的平方减 1 能被 8 整除 |
| m-consecutive-odd | middle/代数证明 | ✓ | auto | 3.7 秒 | — | 两个连续奇数的平方差是 8 的倍数 |
| m-amgm-2 | middle/代数证明 | ✓ | hammer | 0.7 秒 | — | a² + b² ≥ 2ab |
| m-amgm-recip | middle/代数证明 | ✓ | inequality | 2.4 秒 | — | 正数 a, b：a/b + b/a ≥ 2 |
| m-square-nonneg | middle/代数证明 | ✓ | auto | 7.0 秒 | — | x² − 6x + 10 > 0 |
| m-sum-squares-zero | middle/代数证明 | ✓ | auto | 20 秒 | — | (a − 1)² + \|b + 2\| = 0 ⇒ a = 1，b = −2 |
| p-calc-regroup | primary/计算 | ✓ | hammer | 0.4 秒 | — | 凑整：25 × 37 × 4 = 3700 |
| p-decimal-div | primary/计算 | ✓ | hammer | 0.5 秒 | — | 小数除法：7.2 ÷ 0.6 + 1.5 = 13.5 |
| p-frac-mixed | primary/计算 | ✓ | hammer | 0.4 秒 | — | 带分数乘法：1½ × 2⅔ = 4 |
| p-clock-angle | primary/图形 | ✓ | hammer | 0.4 秒 | — | 3:30 时针和分针的夹角是 75° |
| p-speed-average | primary/应用题 | ✓ | hammer | 0.6 秒 | — | 往返平均速度：去 60、回 40 ⇒ 48 |
| p-boat | primary/应用题 | ✓ | auto | 3.1 秒 | — | 流水行船：顺水 18、逆水 12 ⇒ 船速 15、水速 3 |
| p-train-bridge | primary/应用题 | ✓ | hammer | 0.7 秒 | — | 火车过桥：车长 200、桥长 400、速度 20 ⇒ 30 秒 |
| p-work-relay | primary/应用题 | ✓ | hammer | 1.3 秒 | — | 工程问题：甲乙合做 3 天后乙单独做完 ⇒ 还要 7.5 天 |
| p-fraction-of | primary/应用题 | ✓ | hammer | 0.9 秒 | — | 分数应用题：第一天用去 2/5，第二天用去余下的 1/3，还剩 48 ⇒ 原有 120 |
| p-interest | primary/百分数 | ✓ | hammer | 0.4 秒 | — | 利息：本金 5000、年利率 3%、存 2 年，本息 5300 |
| p-cube | primary/图形 | ✓ | hammer | 1.2 秒 | — | 正方体表面积 150 ⇒ 体积 125 |
| p-lcm-three | primary/数论 | ✓ | hammer | 0.4 秒 | — | 4、6、9 的最小公倍数是 36 |
| p-count-odd-multiples | primary/数论 | ✓ | hammer | 0.6 秒 | — | 1 到 50 中是 3 的倍数的奇数有 8 个 |
| p-product-rule | primary/计数 | ✓ | hammer | 0.4 秒 | — | 乘法原理：3 件上衣、4 条裤子、2 双鞋有 24 种搭配 |
| p-paths | primary/计数 | ✓ | hammer | 0.4 秒 | — | 3 × 3 方格从左下到右上的最短路线有 20 条 |
| p-triangle-sides | primary/图形 | ✓ | hammer | 0.5 秒 | — | 两边 5 和 8，第三边为整数的三角形有 9 个 |
| m-quadratic-coef | middle/方程 | ✓ | auto | 4.1 秒 | — | 2x² − 5x + 2 = 0 ⇒ x = 2 或 x = 1/2 |
| m-quadratic-double | middle/方程 | ✓ | hammer | 1.1 秒 | — | 重根：x² − 6x + 9 = 0 ⇒ x = 3 |
| m-quadratic-iff | middle/方程 | ✓ | auto | 18 秒 | — | x² − 5x + 6 = 0 ⇔ x = 2 或 x = 3 |
| m-quadratic-positive | middle/方程 | ✓ | hammer | 1.4 秒 | — | 正根：x² + 2x − 15 = 0，x > 0 ⇒ x = 3 |
| m-quadratic-word | middle/方程 | ✓ | hammer | 1.2 秒 | — | 长比宽多 3、面积 40 的长方形，宽是 5 |
| m-cubic | middle/方程 | ✓ | auto | 2.9 秒 | — | x³ − 6x² + 11x − 6 = 0 ⇒ x = 1, 2, 3 |
| m-system-quadratic | middle/方程 | ✓ | auto | 3.4 秒 | 31 秒 | x + y = 5，xy = 6 ⇒ (2, 3) 或 (3, 2) |
| m-lines-intersection | middle/函数 | ✓ | auto | 4.1 秒 | — | 两条直线 y = 2x + 1 与 y = −x + 7 的交点 (2, 5) |
| m-ineq-quadratic | middle/不等式 | ✓ | auto | 4.6 秒 | — | x² − 5x + 6 < 0 ⇔ 2 < x < 3 |
| m-ineq-frac | middle/不等式 | ✓ | auto | 6.2 秒 | — | 去分母：(x − 1)/2 − (2x + 1)/3 ≤ 1 ⇔ x ≥ −11 |
| m-trig-degrees | middle/几何 | ✓ | auto | 4.2 秒 | — | 用度数写的特殊角：cos 120° = −1/2 |
| m-trig-product | middle/几何 | ✓ | auto | 7.5 秒 | — | sin 45° · cos 45° = 1/2 |
| m-trig-tan-product | middle/几何 | ✓ | hammer | 0.5 秒 | — | tan 30° · tan 60° = 1 |
| m-trig-side | middle/几何 | ✓ | auto | 4.2 秒 | — | 解直角三角形：斜边 10、30° 角的对边是 5 |
| m-surd-sub | middle/二次根式 | ✓ | geometry | 5.9 秒 | — | √18 − √8 = √2 |
| m-surd-square | middle/二次根式 | ✓ | hammer | 0.5 秒 | — | √((−3)²) = 3 |
| m-surd-conjugate | middle/二次根式 | ✓ | geometry | 1.7 秒 | — | (√5 − √3)(√5 + √3) = 2 |
| m-surd-mul | middle/二次根式 | ✓ | geometry | 2.0 秒 | — | √2 × √8 = 4 |
| m-surd-estimate | middle/二次根式 | ✓ | auto | 2.6 秒 | — | 估算：2 < √5 < 3 |
| m-heron | middle/几何 | ✓ | geometry | 2.7 秒 | — | 海伦公式：边长 5、6、7 的三角形面积 6√6 |
| m-tangent-length | middle/几何 | ✓ | hammer | 1.3 秒 | — | 切线长：圆心距 13、半径 5 ⇒ 切线长 12 |
| m-mean-list | middle/概率统计 | ✓ | hammer | 0.4 秒 | — | 一组数据的平均数 |
| m-coins | middle/概率统计 | ✓ | hammer | 0.4 秒 | — | 掷三枚硬币恰好两枚正面有 3 种 |
| m-vertex-form | middle/函数 | ✓ | hammer | 0.4 秒 | — | 配方：x² − 6x + 5 = (x − 3)² − 4 |
| m-coeff-compare | middle/函数 | ✓ | auto | 4.9 秒 | — | 比较系数：x² + ax + b = (x − 1)(x − 3) ⇒ a = −4，b = 3 |
| m-arith-seq | middle/代数式 | ✓ | hammer | 0.5 秒 | — | 等差数列：a₃ = 7，a₇ = 19 ⇒ a₁₀ = 28 |
| m-three-squares | middle/代数证明 | ✓ | hammer | 1.4 秒 | — | a² + b² + c² ≥ ab + bc + ca |
| m-sum-cubes | middle/代数证明 | ✓ | hammer | 0.6 秒 | — | 立方和公式 |
| m-odd-plus-odd | middle/代数证明 | ✓ | hammer | 1.1 秒 | — | 两个奇数的和是偶数 |
| m-square-mod4 | middle/代数证明 | ✓ | auto | 4.1 秒 | — | 平方数除以 4 余 0 或 1 |
| m-consecutive-product | middle/代数证明 | ✓ | hammer | 0.6 秒 | — | 相邻两个自然数的积是偶数 |
| m-digit-reverse | middle/代数证明 | ✓ | hammer | 0.7 秒 | — | 两位数减去它的数字和是 9 的倍数 |
| m-rect-diagonals | middle/几何证明 | ✓ | hammer | 0.5 秒 | — | 矩形的对角线相等（坐标） |
| m-perp-bisector | middle/几何证明 | ✓ | geometry | 2.1 秒 | — | 线段垂直平分线上的点到两端距离相等（坐标） |
| m-thales | middle/几何证明 | ✓ | hammer | 1.0 秒 | — | 直径所对的圆周角是直角（坐标） |
