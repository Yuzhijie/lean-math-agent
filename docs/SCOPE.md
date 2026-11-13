# 产品范围

**结论（2026-11-13，项目所有者确认）：产品是面向学生和老师的解题、出题、批改。** 付费、知识图谱、Clingo 几何求解、专家迭代四块冻结：代码和测试保留，默认关闭，不再往里加东西。

**冻结期限三个月：2027-02-13。** 到那天仍在冻结清单里的，连代码、测试、脚本和依赖一起删除。

冻结清单在 `lib/scope.ts`（程序读的就是它），这份文档解释它。

## 依据

Mac 上是目前唯一在跑的实例，数据如下（2026-11-13）：

| 部分 | 实际使用 |
| --- | --- |
| 解题 | 365 次求解，其中 196 次走到 Lean 这一步 |
| 出题 | 5 个题库，147 道题，118 个分类，16 次导入，63 次出题 |
| 批改 | 0 条记录，没有上传过照片 |
| 账号 | 0 个注册用户，一直是本机单用户 |
| 付费 | 0 个订阅；从未配置 Stripe |
| 知识图谱 | 从未配置 Neo4j |
| Clingo 几何求解 | 从未配置；界面上没有入口 |
| 专家迭代 | 从未跑过：没有训练记录，没有微调出的模型 |

解题和出题有真实使用，冻结的四块一次都没用过。

## 范围内

| 部分 | 做什么 | 代码量（行） |
| --- | --- | ---: |
| 解题 | 分类、求解、讲解、计算服务、多种解法 | 18 000 |
| Lean 验证与证明 | 形式化、反例搜索、程序证明器、模型证明 | 17 000 |
| 图形 | 解题图形、题目配图，由程序计算和检查 | 6 600 |
| 出题 | 题库、导入、同类创编、内置出题、打印 | 12 600 |
| 批改 | 读手写作答、逐步判分、学情、诊断 | 4 400 |
| 账号、额度、部署 | 邀请制登录、额度、排队、Docker | 1 400 |
| 评测 | 端到端留出集、形式化审计、证明器回归、基准 | 4 600 |

Lean 在这个产品里是检查层：给生成的题找反例，给解答的结论出一份机器检查过的证明。

## 冻结

| 名称 | 包括 | 代码量（行，含测试） | 为什么 | 临时打开 |
| --- | --- | ---: | --- | --- |
| 付费（Stripe 订阅） | `lib/payments/`、`/api/payments/*`、`/subscription` 页面、定价卡片 | 700 | 没有一个付费用户，结账流程从未在真实 Stripe 上走通；内测靠邀请名单和额度控制 | `THAW=payments` |
| 知识图谱（Neo4j） | `lib/knowledge/`、`/api/knowledge/*`、`/knowledge` 页面、图谱组件、只有它用的页头 | 920 | 解题、出题、批改都不读它；题库有自己的知识点词表 | `THAW=knowledge` |
| Clingo 几何求解（ASP） | `lib/geometry/`、`/api/solve-geometry`、一个没有被引用的示意图组件 | 790 | 界面没有入口，求解流程不调用它；几何题走图形模块和坐标证明器 | `THAW=clingo` |
| 专家迭代（微调本地证明模型） | `lib/prover/expert-iteration.ts`、`expert:iterate`、`prover:serve`、`proofs:export` 三个脚本 | 1 040 | 属于"定理证明研究"那条路；从未跑过一轮 | `THAW=expert-iteration` |

多项用逗号隔开，`THAW=all` 全部打开。写在 `.env.local` 里或命令前面都行。

### 冻结的规则

1. **默认关闭。** 接口返回 404，页面是"未找到"（也是 404），脚本说明原因后退出。Stripe 的回调地址在冻结时不再对未登录请求开放。
2. **不加功能，不修小毛病（安全问题除外）。** 它的测试照常跑；升级依赖后如果只有它的测试失败，跳过那个测试并注明日期，不花时间修。
3. **范围内的代码不引用冻结的代码。** `tests/scope.test.ts` 逐个文件检查，违反就失败。所以以后删除某一块只是删除，不牵连别处。
4. **数据照常收集。** 证明修复对仍然写入 `.data/proof-repairs.jsonl`，解冻专家迭代时有数据可用。
5. **冻结有期限：2027-02-13。** 现在没有删除，`stripe` 和 `neo4j-driver` 两个依赖也还在 `package.json` 里。到期时仍在清单里的，按下面的"删除清单"删掉（git 历史里还在）。期间用 `THAW` 打开用过、想留下的，在到期前把它从清单里移除。
6. **到期会被拦住。** 从 2027-02-14 起 `tests/scope.test.ts` 失败并列出到期的各项，直到删除完成，或者那一项已从清单移除。改期限只能由项目所有者决定（改 `lib/scope.ts` 里的 `DELETE_AFTER`）。

### 冻结带出来的两处改动

冻结之前，范围内的功能有两样东西放在冻结的代码里，这次搬了出来：

- **套餐额度。** 每月求解次数和同时求解数原来定义在 Stripe 模块里，现在在 `lib/plans.ts`。原来登录用户一律是 free（每月 10 次，一次一道），要提高只能通过 Stripe 订阅——付费冻结后就没有出路了。现在用 `QUOTA_DEFAULT_PLAN` 指定登录用户的套餐（free / pro / enterprise，默认 free），生产环境模板里设为 pro，每天的费用上限照旧生效。
- **账号按钮。** 显示当前登录的人和"退出登录"的按钮原来只出现在订阅页和知识图谱页上，求解、题库、批改三个页面都没有。现在这三个页面在有人登录时显示它；本机单用户模式下不显示。菜单里两个点了没反应的条目（个人资料、设置）去掉了。显示效果用模拟的登录状态在浏览器里检查过，真实的 GitHub / Google 登录没有测。

## 这次冻结没有解决的

- **冻结的四块只占代码的 3.6%**（约 3 400 行，总共约 95 000 行）。范围宽主要不在它们，而在范围内部：解题加证明约 3.5 万行，出题加图形加批改约 2.4 万行。冻结清掉的是入口、依赖和要操心的东西，不是体量。
- **批改在范围内，但没有被用过**：4 400 行，0 条真实记录。建议在有真实老师和学生用过之前（评审的第六条），不再给它加功能。
- **盘点时看到、这次没动的：**
  - `scripts/solve/` 和 `scripts/compute-server-v2.py`（770 行）：没有任何地方启动或调用，实际运行的是 `compute-server.py`。
  - `/api/evaluate`、`/api/intuition`、`/api/solve-compute`、`/api/autoformalize`：界面不调用，只能作为接口直接访问。
  - CLAUDE.md 末尾的 "Current Status & TODO" 已经过时（评审的第七条会处理）。

## 没有选的另一条路：定理证明研究平台

记在这里备查。如果产品是研究平台，清单会变成：

- 专家迭代解冻。
- 题库、出题、批改、打印（约 1.7 万行）冻结，账号、额度、部署也不再需要。
- 付费、知识图谱、Clingo 仍然冻结。

也就是说，付费、知识图谱、Clingo 三块在两条路上都不需要；两条路的差别只在专家迭代和"出题 + 批改"谁留下。

## 怎么改清单

- **临时打开一项**：`THAW=<名称>`。
- **永久解冻一项**：从 `lib/scope.ts` 的 `FROZEN` 里删掉它，去掉接口上的 `frozenRoute`、页面目录里的 `layout.tsx`、脚本里的 `requireThawed`，更新这份文档。
- **冻结新的一项**：在 `FROZEN` 里加一条（代码路径、接口前缀、脚本、测试、专用依赖），给接口包上 `frozenRoute`，给页面目录加 `layout.tsx`，给脚本加 `requireThawed`。`tests/scope.test.ts` 会检查每个入口都关上了，以及范围内没有代码引用它。
- **删除一项**：按下面的清单。

## 删除清单

每一项都是：先删 `FROZEN` 里列的代码和测试，再清掉下面列的零散引用，最后删掉 `FROZEN` 里那一条，跑 `npx tsc --noEmit` 和 `npx vitest run`。

**付费**
- 代码和测试：`lib/payments/`、`app/api/payments/`、`app/subscription/`、`app/components/PricingCards.tsx`、`tests/stripe.test.ts`
- 依赖：`npm uninstall stripe`
- `lib/access.ts`：`STRIPE_WEBHOOK` 和 `isPublicPath` 里对应的半句
- `lib/startup-checks.ts`：Stripe 那条警告
- 数据库的 `Subscription` 表：`lib/quota.ts` 的 `planOf` 还在查它。两种做法选一种：去掉 `prisma/schema.prisma` 里的模型和 `planOf` 的查询，加一个删表的迁移；或者留着这张空表不动
- 配置和文档：`.env.example` 的 Stripe 一节、`.env.production.example` 冻结一节里的 Stripe 说明、`docs/P3-FEATURES.md` 第 11 节、`docs/BETA-DEPLOY.md` 里提到付费的两处、CLAUDE.md 里带 `[frozen: payments]` 的行
- 留下：`lib/plans.ts`（额度在用）

**知识图谱**
- 代码和测试：`lib/knowledge/`、`app/api/knowledge/`、`app/knowledge/`、`app/components/KnowledgeGraph.tsx`、`app/components/Header.tsx`、`tests/neo4j-client.test.ts`
- 依赖：`npm uninstall neo4j-driver`
- `docker-compose.yml`：`neo4j` 服务、`neo4j-data` 和 `neo4j-logs` 两个卷、文件头的说明
- 配置和文档：`.env.example` 的 Neo4j 一节、`.env.production.example` 里的说明、`docs/P3-FEATURES.md` 第 12 节、CLAUDE.md 里带 `[frozen: knowledge]` 的行

**Clingo 几何求解**
- 代码和测试：`lib/geometry/`、`app/api/solve-geometry/`、`app/components/GeometryDiagram.tsx`、`tests/clingo-solver.test.ts`
- 配置和文档：`.env.example` 的 `CLINGO_PATH`、`docs/P3-FEATURES.md` 第 13 节、CLAUDE.md 里带 `[frozen: clingo]` 的行
- 没有专用依赖（clingo 是外部程序）

**专家迭代**
- 代码和测试：`lib/prover/expert-iteration.ts`、`scripts/expert-iterate.ts`、`scripts/prover-serve.ts`、`scripts/proofs-export.ts`、`tests/expert-iteration.test.ts`
- `package.json` 的三个脚本：`expert:iterate`、`prover:serve`、`proofs:export`
- `lib/prover/dataset.ts` 里只有它用的导出：`sftRecords`、`repairRecords`、`isTestSource`、`splitOf`，以及 `tests/proof-dataset.test.ts` 里对应的测试（`harvestRows`、`memoryHitStats` 留下，证明记忆在用）
- 修复对的收集只为它服务：`lib/lean/proof-memory.ts` 的 `rememberRepair`、`readRepairs`，三处调用（`lib/pipeline/lean-attempt.ts`、`lib/pipeline/theorem-pipeline.ts`、`scripts/bench.ts`），以及 `.data/proof-repairs.jsonl`。一起删
- 配置和文档：`.env.example` 的 `EXPERT_*` 和 `PROOF_REPAIRS_PATH`、CLAUDE.md 里带 `[frozen: expert-iteration]` 的行和 Running 一节的三条命令

**四项都删完之后**
- `FROZEN` 变成空的。`lib/scope.ts` 的开关和三道关可以留着（以后再冻结别的还用得上），`tests/scope.test.ts` 里拿具体名称举例的断言（`frozenRoute("payments", …)`、回调地址、启动检查、`closedAt`）跟着删或改
- 这份文档的"冻结"一节改成"已删除"，写上日期和提交号
