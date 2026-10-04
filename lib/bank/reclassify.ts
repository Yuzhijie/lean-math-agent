/**
 * Re-classify questions already in a bank with the model: catalogue place
 * (categories created when missing), grade, knowledge points, difficulty.
 */
import { lt } from "../llm/output-locale";
import { applyClassification, classifyQuestions } from "./classify";
import { BankError, ensureCategoryPath, getBank, listCategories, listItems, updateItem } from "./store";

export const MAX_RECLASSIFY = 1000;

export async function reclassifyItems(
  owner: string,
  bankId: string,
  opts: { itemIds?: string[]; overwrite?: boolean },
): Promise<{ classified: number; failed: number; categories_created: number }> {
  const bank = getBank(owner, bankId);
  if (!bank.allow_model) throw new BankError(lt("该题库设置为不发送给模型，无法自动分类", "This bank is set not to send content to the model, so it cannot be classified automatically"), 400);
  if (!process.env.LLM_API_KEY) throw new BankError(lt("没有配置模型（LLM_API_KEY）", "No model is configured (LLM_API_KEY)"), 400);
  const all = listItems(owner, bankId);
  const wanted = opts.itemIds?.length ? new Set(opts.itemIds) : null;
  const items = wanted ? all.filter((it) => wanted.has(it.id)) : all;
  if (!items.length) throw new BankError(lt("没有要分类的题目", "No questions to classify"), 400);
  if (items.length > MAX_RECLASSIFY) throw new BankError(lt(`一次最多分类 ${MAX_RECLASSIFY} 道题`, `At most ${MAX_RECLASSIFY} questions at a time`), 413);

  const before = listCategories(owner, bankId).length;
  let result;
  try {
    result = await classifyQuestions(items, { bank, categories: listCategories(owner, bankId) });
  } catch (e) {
    throw new BankError(lt(`模型分类失败：${e instanceof Error ? e.message : String(e)}`, `Model classification failed: ${e instanceof Error ? e.message : String(e)}`), 502);
  }
  let classified = 0;
  items.forEach((it, i) => {
    const c = result[i];
    if (!c) return;
    const { category_path, ...fields } = applyClassification(it, c, opts.overwrite ?? false);
    const leaf = category_path?.length ? ensureCategoryPath(owner, bankId, category_path) : undefined;
    updateItem(owner, bankId, it.id, {
      grade: fields.grade,
      difficulty: fields.difficulty,
      knowledge_points: fields.knowledge_points,
      type: fields.type,
      classified: fields.classified,
      category_ids: leaf && !it.category_ids.includes(leaf) ? [...it.category_ids, leaf] : it.category_ids,
    });
    classified++;
  });
  return { classified, failed: items.length - classified, categories_created: listCategories(owner, bankId).length - before };
}
