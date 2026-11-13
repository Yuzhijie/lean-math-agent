# 证明器回归（真实 Lean，不调模型）

由 `npm run lean:regress` 生成（2026-11-13 04:58 UTC）。清单 `bench/provers.json`（provers-v1）里有 160 条陈述：各个程序证明器开发时验证过的陈述，以及过去的求解里由程序证出的陈述。每条都记着“由哪条路线证出”。脚本用产品自己的不调模型的流程（自动化 → 乘法阶 → 逐个检查 → 几何 → 归纳 → 优化 → 组合 → 策略搜索）在真实的 Lean 里重跑一遍。

- **通过** = 仍由记录的那条路线证出。**换了路线** = 证出了，但不是原来那条（通常是前面的路线变强了；也可能是原来的证明器坏了、后面的路线接住了，值得看一眼）。**没证出** = 退化。
- 什么时候跑：升级沙箱的 Mathlib 之前和之后各一次；改动某个证明器之后（`--only geometry`）。日常用 `--quick`（跳过要几分钟的用例）。
- 用时只在同一台机器的两次运行之间比较。

## 历次运行

| 运行 | 机器 | Lean / Mathlib | 用例 | 通过 | 换了路线 | 没证出 | 不该证却证了 | 出错 | 用时 | 提交 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-13 02:07 | linux-x64-5bce98 | Lean 4.33.1 / Mathlib v4.33.1 | 160 | 158 | 0 | 2 | 0 | 0 | 114.3 分钟 | — |

## 最近一次运行：2026-11-13 02:07

160 条用例：158 条通过，0 条换了路线，0 条没证出，0 条不该证出却证出了，0 条运行出错，2 条仍未证出。**没有退化。**

### 按证明器

| 为哪个证明器而写 | 用例 | 通过 | 换了路线 | 没通过 | 总用时 | 最慢的一条 |
| --- | --- | --- | --- | --- | --- | --- |
| （不该证出的陈述） | 1 | 1 | 0 | 0 | 32 秒 | none-false-arithmetic（32 秒） |
| hammer | 26 | 25 | 0 | 1 | 20.3 分钟 | s-hammer-18（18.2 分钟） |
| trivial | 5 | 5 | 0 | 0 | 5.7 分钟 | s-trivial-04（2.3 分钟） |
| order | 3 | 3 | 0 | 0 | 27 秒 | s-order-02（17 秒） |
| bounded | 2 | 2 | 0 | 0 | 9.9 秒 | s-bounded-01（5.0 秒） |
| induction | 35 | 35 | 0 | 0 | 2.8 分钟 | ind-u15（12 秒） |
| optimize | 28 | 28 | 0 | 0 | 11.6 分钟 | fam-minu（5.2 分钟） |
| auto | 16 | 15 | 0 | 1 | 9.7 分钟 | auto-denominators（3.7 分钟） |
| combinatorics | 22 | 22 | 0 | 0 | 14.8 分钟 | s-combinatorics-03（2.1 分钟） |
| geometry | 22 | 22 | 0 | 0 | 48.2 分钟 | geo-main20（10.8 分钟） |

### 没有按预期通过的用例

| 用例 | 为它而写 | 预期 | 结果 | 用时 | 说明 |
| --- | --- | --- | --- | --- | --- |
| s-hammer-18 | hammer | — | 仍未证出（没有记录过路线） | 18.2 分钟 | 从 {1,…,15} 中选 6 个互不相邻的元素、和被 3 整除的子集个数 = 72。Mac 上的求解记录里由 hammer 证出；云端 7 GB 的机器上证不出（时间和内存都不够），路线待在 Mac 上确认；自动化策略组合（rfl、decide、decide +kernel、simp、omega、norm_num、ring、linarith、aesop 等）；程序写的归纳证明（no natural-number variable to induct on）；程序写的组合证明（the combinatorics prover ran out of time）；策略组合搜索（no combination closed every goal (78 tactics tried)） |
| auto-denominators | auto/denominators | — | 仍未证出（没有记录过路线） | 3.7 分钟 | 幂和 5、11、29 ⇒ Σ 1/(x + 1) = 5/4。把策略搜索的时限放宽到默认的 60 秒以上时，在云端用 221 秒证出过；默认时限内云端证不出，路线待在 Mac 上确认；自动化策略组合（rfl、decide、decide +kernel、simp、omega、norm_num、ring、linarith、aesop 等）；策略组合搜索（no combination closed every goal (39 tactics tried)） |

### 全部用例

| 用例 | 为它而写 | 结果 | 路线 | 用时 | 是什么 |
| --- | --- | --- | --- | --- | --- |
| none-false-arithmetic | — | ✓ | （不该证出） | 32 秒 | a false statement: must not be proved |
| hammer-gcd-powers | hammer | ✓ | hammer | 0.3 秒 | gcd(2^2024 + 1, 2^3036 − 1) = 1 (decide +kernel on big numbers) |
| s-hammer-01 | hammer | ✓ | hammer | 0.3 秒 | 证明对任意自然数 n，n + 0 = n |
| s-hammer-02 | hammer | ✓ | hammer | 19 秒 | 设 $N=2025=3^4\cdot 5^2$。对满足 $1\le x\le N$ 且 $(x,N)=1$ 的整数 $x… |
| s-hammer-03 | hammer | ✓ | hammer | 0.4 秒 | This is Maya’s juice bottle. Maya drank half of the juice. W… |
| s-hammer-04 | hammer | ✓ | hammer | 0.5 秒 | Noah spins this wheel at a fairground game. On which number … |
| s-hammer-05 | hammer | ✓ | hammer | 0.4 秒 | Jake had these vegetables. He used 4 of the vegetables to ma… |
| s-hammer-06 | hammer | ✓ | hammer | 0.3 秒 | Jenny faced the house and hid the key under the furthest pot… |
| s-hammer-07 | hammer | ✓ | hammer | 0.7 秒 | 在三角形 $ABC$ 中，$AB=13$，$AC=14$，$BC=15$。三角形 $ABC$ 的内切圆分别与边 $AB$… |
| s-hammer-08 | hammer | ✓ | hammer | 0.6 秒 | Four children took part in a relay race. Their finishing ord… |
| s-hammer-09 | hammer | ✓ | hammer | 0.4 秒 | In each triangle, the numbers at the corners are used to cal… |
| s-hammer-10 | hammer | ✓ | hammer | 2.2 秒 | 有4个盒子，编号分别为1、2、3、4，其中只有1个盒子里装有礼物。甲、乙、丙、丁各说了一句话： 甲：礼物在1号盒或2号盒… |
| s-hammer-11 | hammer | ✓ | hammer | 16 秒 | 从集合 $\{1,2,3,\ldots,12\}$ 中选出恰好 $4$ 个数，要求任意两个被选数之差的绝对值都不等于 $… |
| s-hammer-12 | hammer | ✓ | hammer | 16 秒 | 将正十二边形的顶点按顺时针方向编号为 $A_1,A_2,\\ldots,A_{12}$，其中下标按模 $12$ 循环，即… |
| s-hammer-13 | hammer | ✓ | hammer | 15 秒 | A maximum of 3 triangles can be traced in this drawing. What… |
| s-hammer-14 | hammer | ✓ | hammer | 1.0 秒 | Four students—Alice, Ben, Cara, and David—stand in a single … |
| s-hammer-15 | hammer | ✓ | hammer | 0.8 秒 | Three runners—Ana, Ben, and Cara—finish a race in first, sec… |
| s-hammer-16 | hammer | ✓ | hammer | 1.6 秒 | Four runners—Alex, Ben, Chloe, and Diego—finish a race in fo… |
| s-hammer-17 | hammer | ✓ | hammer | 0.5 秒 | An apple is hidden in exactly one of three boxes: a red box,… |
| s-hammer-18 | hammer | 仍未证出（没有记录过路线） | — | 18.2 分钟 | 从 {1,…,15} 中选 6 个互不相邻的元素、和被 3 整除的子集个数 = 72。Mac 上的求解记录里由 hammer 证出；云端 7 GB 的机器上证不出（时间和内存都不够… |
| s-hammer-19 | hammer | ✓ | hammer | 0.4 秒 | 设整数 $r$ 满足 $0\le r<2025$ 且 $r$ 是 $2^{2025}+3^{2025}$ 除以 $202… |
| s-hammer-20 | hammer | ✓ | hammer | 0.5 秒 | 设全集为 $U=\{1,2,3,\ldots,30\}$。集合 $A$ 由 $U$ 中所有能被 $2$ 整除的数构成，集… |
| s-hammer-21 | hammer | ✓ | hammer | 37 秒 | 从集合 $\{1,2,3,\ldots,14\}$ 中选出 $6$ 个不同的数，要求任意两个被选出的数都不相邻，且这 $… |
| s-hammer-22 | hammer | ✓ | hammer | 10 秒 | 从集合 $\{1,2,3,\ldots,12\}$ 中选出 $5$ 个不同的数，要求任意两个被选出的数都不相邻，且这 $… |
| s-hammer-23 | hammer | ✓ | hammer | 4.0 秒 | 某仓库有一批螺丝，数量为正整数，且大于$500$个、小于$1000$个。若每$7$个装一袋，恰好余下$2$个；若每$9$… |
| s-hammer-24 | hammer | ✓ | hammer | 0.4 秒 | I buy a 4$ bag of figs from a roadside stall. I have a 5$ no… |
| s-hammer-25 | hammer | ✓ | hammer | 0.6 秒 | In this puzzle, the tiles have patterns on one side only. Th… |
| s-trivial-01 | trivial | ✓ | hammer | 0.3 秒 | 证明对任意自然数 n，n + 0 = n |
| s-trivial-02 | trivial | ✓ | trivial | 52 秒 | 在一个 $3\times 4$ 的方格板上选出 $5$ 个小方格，要求任意两个被选小方格都不具有公共边。问共有多少种不同… |
| s-trivial-03 | trivial | ✓ | trivial | 2.1 分钟 | 从集合 $\{1,2,3,\ldots,12\}$ 中选出 $5$ 个不同的数，要求任意两个被选数之差的绝对值都不小于 … |
| s-trivial-04 | trivial | ✓ | trivial | 2.3 分钟 | 从集合 $\{1,2,3,\ldots,14\}$ 中选出 $5$ 个不同的数，要求任意两个被选出的数之差的绝对值都不等… |
| s-trivial-05 | trivial | ✓ | trivial | 29 秒 | 甲、乙、丙、丁四人中，每人要么始终说真话，要么始终说假话。四人的发言如下： 甲："乙说的是假话。" 乙："丙说的是假话。… |
| order-3780 | order | ✓ | order | 7.4 秒 | smallest n with 3⁴·5²·127 ∣ 2ⁿ − 1 |
| s-order-01 | order | ✓ | order | 3.0 秒 | 求满足下列两个同余条件的最小正整数 $n$： $$ 2^n\equiv 1\pmod{3^6\cdot 5^3\cdot… |
| s-order-02 | order | ✓ | order | 17 秒 | 设 $v_p(m)$ 表示正整数 $m$ 的质因数 $p$ 的指数，即 $p^{v_p(m)}\mid m$ 且 $p^… |
| bounded-649 | bounded | ✓ | bounded | 4.9 秒 | smallest m > 1 with 2025 ∣ m² − 1 |
| s-bounded-01 | bounded | ✓ | bounded | 5.0 秒 | 求最小的正整数 $m>1$，使得 $2025\mid (m^2-1)$。 |
| ind-t1 | induction | ✓ | induction | 4.5 秒 | ind_t1 |
| ind-t2 | induction | ✓ | induction | 6.6 秒 | ind_t2 |
| ind-t3 | induction | ✓ | induction | 4.6 秒 | ind_t3 |
| ind-t4 | induction | ✓ | induction | 4.5 秒 | ind_t4 |
| ind-t5 | induction | ✓ | induction | 4.0 秒 | ind_t5 |
| ind-t6 | induction | ✓ | induction | 7.8 秒 | ind_t6 |
| ind-t7 | induction | ✓ | induction | 7.6 秒 | ind_t7 |
| ind-t8 | induction | ✓ | induction | 6.7 秒 | ind_t8 |
| ind-t9 | induction | ✓ | induction | 5.7 秒 | ind_t9 |
| ind-t10 | induction | ✓ | induction | 3.9 秒 | ind_t10 |
| ind-t11 | induction | ✓ | induction | 4.4 秒 | ind_t11 |
| ind-t12 | induction | ✓ | induction | 4.8 秒 | ind_t12 |
| ind-t13 | induction | ✓ | induction | 4.6 秒 | ind_t13 |
| ind-t14 | induction | ✓ | induction | 5.4 秒 | ind_t14 |
| ind-t15 | induction | ✓ | induction | 3.8 秒 | ind_t15 |
| ind-t16 | induction | ✓ | induction | 3.8 秒 | ind_t16 |
| ind-t17 | induction | ✓ | induction | 6.3 秒 | ind_t17 |
| ind-t18 | induction | ✓ | induction | 4.2 秒 | ind_t18 |
| ind-t19 | induction | ✓ | induction | 6.7 秒 | ind_t19 |
| ind-t20 | induction | ✓ | induction | 4.6 秒 | ind_t20 |
| ind-t21 | induction | ✓ | induction | 4.6 秒 | ind_t21 |
| ind-t22 | induction | ✓ | induction | 4.0 秒 | ind_t22 |
| ind-t23 | induction | ✓ | induction | 3.6 秒 | ind_t23 |
| ind-u1 | induction | ✓ | induction | 6.3 秒 | ind_u1 |
| ind-u2 | induction | ✓ | hammer | 0.9 秒 | ind_u2 |
| ind-u3 | induction | ✓ | induction | 5.1 秒 | ind_u3 |
| ind-u4 | induction | ✓ | hammer | 0.6 秒 | ind_u4 |
| ind-u5 | induction | ✓ | induction | 6.2 秒 | ind_u5 |
| ind-u6 | induction | ✓ | induction | 4.4 秒 | ind_u6 |
| ind-u8 | induction | ✓ | induction | 4.6 秒 | ind_u8 |
| ind-u9 | induction | ✓ | induction | 4.5 秒 | ind_u9 |
| ind-u10 | induction | ✓ | induction | 5.2 秒 | ind_u10 |
| ind-u12 | induction | ✓ | induction | 4.6 秒 | ind_u12 |
| ind-u13 | induction | ✓ | hammer | 0.4 秒 | ind_u13 |
| ind-u15 | induction | ✓ | induction | 12 秒 | ind_u15 |
| fam-oddtown | optimize/oddtown | ✓ | optimize | 27 秒 | Oddtown on 4 points |
| fam-odd2 | optimize/oddtown | ✓ | optimize | 38 秒 | Oddtown on Finset.range n, sizes as % 2 = 1 |
| fam-odd3 | optimize/oddtown | ✓ | optimize | 22 秒 | Oddtown on Fin 9 (Finset.univ) |
| fam-odd4 | optimize/oddtown | ✓ | optimize | 36 秒 | Oddtown as ∀ F … ≤ n ∧ ∃ F |
| fam-oddn | optimize/oddtown | ✓ | optimize | 40 秒 | Oddtown on {1, …, n} with the witness behind lets |
| fam-ekr | optimize/ekr | ✓ | optimize | 6.7 秒 | Erdős–Ko–Rado: 4-subsets of 10 points, any two meet ⇒ ≤ 84 |
| fam-eventown | optimize/family | ✓ | optimize | 9.5 秒 | Eventown on 6 points ⇒ 8 (colouring) |
| fam-ev2 | optimize/family | ✓ | optimize | 11 秒 | Eventown on Fin 6 without a ground-set condition |
| fam-inter | optimize/family | ✓ | optimize | 4.7 秒 | intersecting families on 4 points ⇒ 8 |
| fam-sperner | optimize/family | ✓ | optimize | 5.1 秒 | Sperner: antichains on 4 points ⇒ 6 |
| fam-minu | optimize | ✓ | optimize | 5.2 分钟 | least \|A ∪ B\| for \|A\| = 5, \|B\| = 7 in Fin 10 |
| fam-sd | optimize/venn | ✓ | optimize | 83 秒 | \|A\| = \|B\| = \|C\| = 18, pairwise ∩ 6, \|U\| = 40 ⇒ max \|A △ B △ C\| = 34 |
| fam-wrong7 | optimize/family | ✓ | （不该证出） | 19 秒 | Eventown on 6 points with the wrong value 7: must not be proved |
| opt-o1 | optimize | ✓ | optimize | 4.0 秒 | opt_o1 |
| opt-o2 | optimize | ✓ | optimize | 3.6 秒 | opt_o2 |
| opt-o3 | optimize | ✓ | hammer | 1.1 秒 | opt_o3 |
| opt-o4 | optimize | ✓ | optimize | 5.0 秒 | opt_o4 |
| opt-o5 | optimize | ✓ | optimize | 22 秒 | opt_o5 |
| opt-o6 | optimize | ✓ | optimize | 3.8 秒 | opt_o6 |
| opt-o7 | optimize | ✓ | optimize | 5.8 秒 | opt_o7 |
| opt-o9 | optimize | ✓ | hammer | 0.5 秒 | opt_o9 |
| opt-o11 | optimize | ✓ | optimize | 3.2 秒 | opt_o11 |
| opt-o12 | optimize | ✓ | optimize | 4.1 秒 | opt_o12 |
| opt-o13 | optimize | ✓ | optimize | 4.6 秒 | opt_o13 |
| opt-o14 | optimize | ✓ | optimize | 4.2 秒 | opt_o14 |
| opt-o15 | optimize | ✓ | optimize | 6.8 秒 | opt_o15 |
| opt-o16 | optimize | ✓ | optimize | 4.0 秒 | opt_o16 |
| opt-o17 | optimize | ✓ | optimize | 3.4 秒 | opt_o17 |
| auto-divbound | auto/divbound | ✓ | auto | 8.4 秒 | n + 5 ∣ n² + 14 ∧ 2n + 1 ∣ n² + 4 ⇔ n = 8 |
| auto-denominators | auto/denominators | 仍未证出（没有记录过路线） | — | 3.7 分钟 | 幂和 5、11、29 ⇒ Σ 1/(x + 1) = 5/4。把策略搜索的时限放宽到默认的 60 秒以上时，在云端用 221 秒证出过；默认时限内云端证不出，路线待在 Mac 上确… |
| auto-doublecount-20 | auto/doublecount | ✓ | auto | 31 秒 | 20 elements each in 3 of 6 sets, equal pairwise intersections ⇒ k = 4 |
| auto-doublecount-ne | auto/doublecount | ✓ | auto | 7.9 秒 | double counting with i ≠ j (ordered pairs) |
| auto-doublecount-alpha | auto/doublecount | ✓ | auto | 8.9 秒 | double counting, another formalization |
| auto-polyfunc-1024 | auto/polyfunc | ✓ | auto | 6.4 秒 | P(x²) = P(x)², P(2) = 1024 ⇒ P = X¹⁰ |
| auto-polyfunc-243 | auto/polyfunc | ✓ | auto | 28 秒 | Q(t²) = Q(t)², Q(3) = 243 ⇒ Q = X⁵ |
| auto-realopt-min | auto/realopt | ✓ | auto | 12 秒 | x + y + z = 3, x² + y² + z² = 9 ⇒ min xyz = −4 |
| auto-realopt-max | auto/realopt | ✓ | auto | 10 秒 | a + b + c = 0, a² + b² + c² = 6 ⇒ max abc = 2 |
| auto-realopt-xy | auto/realopt | ✓ | auto | 4.1 秒 | x + y = 2 ⇒ max xy = 1 |
| auto-amgm | auto/amgm | ✓ | auto | 69 秒 | abc = 1 ⇒ (a² + b² + c²)/(a + b + c) ≥ 1, equality iff a = b = c = 1 |
| s-auto-01 | auto | ✓ | auto | 43 秒 | 设 $a,b,c$ 是两两不相等的实数，满足 $a+b+c=0$，$a^2+b^2+c^2=6$，且 $abc=1$。求… |
| s-auto-02 | auto | ✓ | auto | 46 秒 | 设有限集 $U$ 中有 $20$ 个元素，且 $A_1,A_2,A_3,A_4,A_5,A_6$ 都是 $U$ 的子集。… |
| s-auto-03 | auto | ✓ | auto | 7.4 秒 | 设 $P(x)$ 是一个实系数多项式，满足对任意实数 $x$ 都有 $$P(x^2)=P(x)^2.$$ 另外，已知 $… |
| s-auto-04 | auto | ✓ | auto | 12 秒 | 设 $x,y,z$ 为实数，满足 $$x+y+z=3,\qquad x^2+y^2+z^2=9.$$ 求 $xyz$ 的… |
| s-auto-05 | auto | ✓ | auto | 64 秒 | 设正实数 $a,b,c$ 满足 $abc=1$，求分式 $$ \frac{a^2+b^2+c^2}{a+b+c} $$ … |
| comb-venn-exactly-one | combinatorics/venn | ✓ | combinatorics | 47 秒 | \|U\| = 30 …: exactly one of A, B, C = 12 (set equation as card fact) |
| comb-venn-let | combinatorics/venn | ✓ | combinatorics | 45 秒 | exactly one of A, B, C with the set behind a let |
| comb-circular-8 | combinatorics/circular | ✓ | combinatorics | 18 秒 | 8 students round a table, A, B, C pairwise apart, D, E apart = 1152 |
| comb-circular-5 | combinatorics/circular | ✓ | combinatorics | 6.9 秒 | 5 round a table = 24 |
| comb-circular-8-seats | combinatorics/circular | ✓ | combinatorics | 101 秒 | seat ↦ person form with conditions over seats |
| comb-circular-5-seats | combinatorics/circular | ✓ | combinatorics | 37 秒 | 5 round a table, seat ↦ person |
| comb-circular-8-helper | combinatorics/circular | ✓ | combinatorics | 100 秒 | arrangement only through an ∃ i helper |
| comb-o15 | combinatorics/orbit | ✓ | combinatorics | 50 秒 | 5 of 15 seats, no two adjacent, up to the dihedral group = 16 |
| comb-o12rot | combinatorics/orbit | ✓ | combinatorics | 11 秒 | 4 of 12, rotations only = 10 |
| comb-o15wrong | combinatorics/orbit | ✓ | （不该证出） | 42 秒 | the 15-seat count with a wrong number: must not be proved |
| comb-venn3 | combinatorics/venn | ✓ | combinatorics | 46 秒 | three sets in a universe of 100 |
| comb-venn2 | combinatorics/venn | ✓ | combinatorics | 6.3 秒 | \|A ∪ B\| from \|A\|, \|B\|, \|A ∩ B\| |
| comb-venn2c | combinatorics/venn | ✓ | combinatorics | 10 秒 | outside both of two sets |
| comb-cube | combinatorics/finite | ✓ | hammer | 0.7 秒 | which faces of a cube can meet at a corner |
| comb-div500 | combinatorics/finite | ✓ | trivial | 114 秒 | n ≤ 500 with 12 divisors, 6 ∣ n, 12 ∤ n = 10 |
| comb-ncard | combinatorics/finite | ✓ | combinatorics | 7.7 秒 | Set.ncard of the 2-subsets of Fin 6 |
| comb-natcard | combinatorics/finite | ✓ | hammer | 2.1 秒 | Nat.card of a subtype |
| comb-tri7 | combinatorics/finite | ✓ | hammer | 1.9 秒 | triangles in a drawing given as an edge relation |
| comb-rot3 | combinatorics/orbit | ✓ | combinatorics | 13 秒 | 3 of 12 avoiding 0, up to rotation = 19 |
| s-combinatorics-01 | combinatorics | ✓ | combinatorics | 53 秒 | 设全集 $U$ 为有限集合，且 $A,B,C$ 是 $U$ 的三个子集。已知 $\|U\|=40$，$\|A\|=22$，$\|B… |
| s-combinatorics-02 | combinatorics | ✓ | combinatorics | 48 秒 | 设全集 $U$ 是一个含有 $30$ 个元素的集合，$A,B,C$ 是 $U$ 的三个子集，且满足 $\|A\|=18$，$… |
| s-combinatorics-03 | combinatorics | ✓ | combinatorics | 2.1 分钟 | 8名不同的学生 $A,B,C,D,E,F,G,H$ 围坐在圆桌旁。若整体旋转后的位置安排视为同一种安排，但镜像反射视为不… |
| geo-cbd | geometry/angles | ✓ | geometry | 115 秒 | AB = AC, ∠A = 20°, D on AC with AD = BC ⇒ ∠CBD = 70° |
| geo-isosceles-triangle-20deg-bd-be-equilateral | geometry/field | ✓ | geometry | 3.1 分钟 | AB = AC, ∠A = 20°, BD = BE = BC ⇒ BDE equilateral (B, C fixed, A free) |
| geo-isosceles-triangle-angle-cbd | geometry/angles | ✓ | geometry | 14 秒 | AB = AC, ∠A = 40°, BD = BC ⇒ ∠CBD = 40° |
| geo-langley | geometry/angles | ✓ | geometry | 4.5 分钟 | Langley's 80-80-20 triangle: ∠PBC = 30°, ∠PCB = 10° ⇒ ∠BAP = 50° |
| geo-main20 | geometry/field | ✓ | geometry | 10.8 分钟 | AB = AC, ∠A = 20°, BD = BE = BC ⇒ BDE equilateral (free b, p, q) |
| geo-orthoref | geometry/witness | ✓ | geometry | 120 秒 | orthocentre's reflections lie on the circumcircle, [XYZ]/[ABC] = √3 − 1 (A = 60°, B = 45°) |
| geo-orthoref3 | geometry/witness | ✓ | geometry | 2.4 分钟 | the same, a third formalization |
| geo-pent | geometry | ✓ | geometry | 73 秒 | regular pentagon: diagonals' intersection ratio (nested roots) |
| geo-regular-pentagon-diagonal-intersection-ratio | geometry | ✓ | geometry | 59 秒 | regular pentagon, another formalization |
| geo-right-triangle-altitude-angle-bisector-distance | geometry | ✓ | geometry | 13 秒 | right triangle 6-8-10: altitude foot and bisector foot |
| geo-right-triangle-angle-bisector-area | geometry | ✓ | geometry | 14 秒 | right triangle 3-4-5: bisector, area |
| geo-t2 | geometry/angles | ✓ | geometry | 4.2 分钟 | angle chase with two auxiliary points |
| geo-t3 | geometry/angles | ✓ | geometry | 72 秒 | angle chase, one free point |
| geo-t5 | geometry/angles | ✓ | geometry | 54 秒 | angle chase, one free point (second) |
| geo-t6 | geometry/angles | ✓ | geometry | 85 秒 | angle chase with a point on a side |
| geo-triangle-angle-bisector-foot-is-ac-midpoint | geometry | ✓ | geometry | 68 秒 | bisector foot is the midpoint of AC |
| geo-triangle-angle-bisector-perpendicular-feet-distance | geometry | ✓ | geometry | 42 秒 | 13-14-15: feet of perpendiculars from the bisector's foot |
| s-geometry-01 | geometry | ✓ | geometry | 8.7 分钟 | 在等腰三角形 $ABC$ 中，$AB=AC$，且 $\\angle BAC=20^\\circ$。在线段 $AC$ 的内… |
| s-geometry-02 | geometry | ✓ | geometry | 48 秒 | 设锐角三角形 $ABC$ 满足 $\angle A=60^\circ$，$\angle B=45^\circ$，$\an… |
| s-geometry-03 | geometry | ✓ | geometry | 57 秒 | 在三角形 $ABC$ 中，$AB=13$，$BC=15$，$CA=14$。其内切圆分别与 $BC$、$CA$、$AB$ … |
| s-geometry-04 | geometry | ✓ | geometry | 15 秒 | 在直角三角形 $ABC$ 中，$ ngle A=90^\circ$，$AB=6$，$AC=8$。设三角形 $ABC$ 的… |
| s-geometry-05 | geometry | ✓ | geometry | 14 秒 | 圆 $\omega$ 的半径为 $5$，弦 $AB=8$。在点 $A$ 和 $B$ 处分别作圆 $\omega$ 的切线… |
