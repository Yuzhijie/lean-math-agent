# 同义变体：证明器对“换一种写法”的稳健性（真实 Lean，不调模型）

由 `npm run lean:variants` 生成（2026-11-16 14:09 UTC）。回归清单 `bench/provers.json` 里由专用证明器、程序脚本或策略搜索证出的每条陈述，被改写成**意思相同、写法不同**的变体：

- 约束变量加撇（n → n'）
- 约束变量换字母，长名字加下标（n → q，Valid → Valid₁）
- 单字母变量加下标（x → x₁）
- 名字换大小写（Valid → valid）
- ∀ 写法与参数写法互换
- 比较号两边对调（0 < n → n > 0）

每个变体先由 Lean 核对与原陈述等价（`A ↔ B` 由 `Iff.rfl` 证出），再单独交给证出原陈述的那条路线；那条路线没证出时，再交给产品其余不调模型的阶段。同一道题重新形式化一次，差别正是这几种；变体没证出、或者要靠别的路线才证出，说明那个证明器读的是文字，不是数学。

- **同一路线** = 由证出原陈述的那条路线证出。**换了路线** = 那条路线没证出，别的路线接住了（通常更慢，也更靠运气）。**丢失** = 都没证出（其余路线有时间上限，见运行命令的 `--budget`）。
- Lean 没能确认等价的变体（改写程序的局限）不计入，单列在最后。
- “规范写法”一栏：证明器读到的是不是统一成一种写法的陈述（`lib/lean/reading-form.ts`；产品里是开）。`PROVER_READING_FORM=0 npm run lean:variants` 让证明器直接读变体原文，用来对比。

## 历次运行

| 运行 | 规范写法 | 机器 | 陈述 | 变体 | 同一路线 | 换了路线 | 丢失 | 未确认等价 | 用时 | 提交 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-16 02:37 | 关 | linux-x64-5bce98 | 116 | 466 | **428（92%）** | 0 | 38 | 0 | 95.6 分钟 | `1dfe758` | 这次改动之前的代码（提交 1dfe758），证明器直接读变体原文；慢的 12 条只测了加撇、加下标、比较号对调三种 |
| 2026-11-16 11:50 | 开 | linux-x64-5bce98 | 116 | 494 | **494（100%）** | 0 | 0 | 0 | 136.7 分钟 | — | 这次改动之后；两条吃紧的搜索题（auto-amgm、s-auto-05）在两次运行里都放宽了搜索时限 |

## 最近一次运行：2026-11-16 11:50

116 条陈述的 494 个变体：**494 个（100%）由同一路线证出**，0 个换了路线，0 个丢失。**每个变体都由原来的路线证出。**

### 按证明器

| 为哪个证明器而写 | 变体 | 同一路线 | 换了路线 | 丢失 |
| --- | --- | --- | --- | --- |
| order | 13 | 13（100%） | 0 | 0 |
| bounded | 8 | 8（100%） | 0 | 0 |
| induction | 139 | 139（100%） | 0 | 0 |
| optimize | 110 | 110（100%） | 0 | 0 |
| auto | 69 | 69（100%） | 0 | 0 |
| combinatorics | 74 | 74（100%） | 0 | 0 |
| geometry | 81 | 81（100%） | 0 | 0 |

### 按专门路线

| 路线 | 变体 | 同一路线 | 换了路线 | 丢失 |
| --- | --- | --- | --- | --- |
| optimize/oddtown | 21 | 21（100%） | 0 | 0 |
| optimize/ekr | 3 | 3（100%） | 0 | 0 |
| optimize/family | 12 | 12（100%） | 0 | 0 |
| optimize/process | 24 | 24（100%） | 0 | 0 |
| auto/divbound | 5 | 5（100%） | 0 | 0 |
| auto/doublecount | 16 | 16（100%） | 0 | 0 |
| auto/polyfunc | 10 | 10（100%） | 0 | 0 |
| auto/realopt | 9 | 9（100%） | 0 | 0 |
| combinatorics/venn | 25 | 25（100%） | 0 | 0 |
| combinatorics/circular | 16 | 16（100%） | 0 | 0 |
| combinatorics/orbit | 16 | 16（100%） | 0 | 0 |
| combinatorics/finite | 3 | 3（100%） | 0 | 0 |
| geometry/angles | 28 | 28（100%） | 0 | 0 |
| optimize/venn | 5 | 5（100%） | 0 | 0 |
| geometry/witness | 4 | 4（100%） | 0 | 0 |
| auto/amgm | 6 | 6（100%） | 0 | 0 |

### 按改写的种类

| 改写 | 变体 | 同一路线 | 换了路线 | 丢失 |
| --- | --- | --- | --- | --- |
| 约束变量加撇（n → n'） | 116 | 116（100%） | 0 | 0 |
| 约束变量换字母，长名字加下标（n → q，Valid → Valid₁） | 116 | 116（100%） | 0 | 0 |
| 单字母变量加下标（x → x₁） | 115 | 115（100%） | 0 | 0 |
| 名字换大小写（Valid → valid） | 52 | 52（100%） | 0 | 0 |
| ∀ 写法与参数写法互换 | 66 | 66（100%） | 0 | 0 |
| 比较号两边对调（0 < n → n > 0） | 29 | 29（100%） | 0 | 0 |

### 与上一次（2026-11-16 02:37）相比

两次都跑过的 466 个变体：同一路线证出 428（92%）→ 466（100%）；丢失 38 → 0，换了路线 0 → 0。新由同一路线证出 38 个（order-3780~prime、order-3780~subscript、s-order-01~prime、s-order-01~subscript、s-order-02~prime、s-order-02~letters、s-order-02~subscript、s-order-02~flip、bounded-649~prime、bounded-649~subscript、bounded-649~flip、s-bounded-01~prime、s-bounded-01~subscript、s-bounded-01~flip、ind-u3~prime、ind-u3~subscript、fam-odd4~flip、proc-board~letters、proc-board~subscript、proc-least15~letters、proc-least15~subscript、proc-dist10~letters、proc-dist10~subscript、proc-abs7~letters、proc-abs7~subscript、proc-ite8~letters、proc-ite8~subscript、proc-let12~letters、proc-let12~subscript、geo-right-triangle-altitude-angle-bisector-distance~flip ……），退步 0 个。
