"use client";

import { useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { api, bankUrl, errMsg, type Bank } from "./api";
import { CheckboxField, ErrorNote, FieldLabel, Modal, NativeSelect, languageLabel } from "./ui";

const LANGS: Bank["language"][] = ["zh", "en", "mixed"];

function LanguageSelect({ value, onChange }: { value: Bank["language"]; onChange: (v: Bank["language"]) => void }) {
  const { tr } = useI18n();
  return (
    <NativeSelect value={value} onChange={(v) => onChange(v as Bank["language"])} ariaLabel={tr("题库语言", "Bank language")}>
      {LANGS.map((l) => (
        <option key={l} value={l}>
          {languageLabel(l, tr)}
        </option>
      ))}
    </NativeSelect>
  );
}

/** "New bank" dialog. */
export function NewBankDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (bank: Bank) => void }) {
  const { tr, locale } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState<Bank["language"]>(locale === "en-US" ? "en" : "zh");
  const [allowModel, setAllowModel] = useState(true);
  const [pinLanguage, setPinLanguage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) {
      setError(tr("请填写题库名称", "Enter a name for the bank"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { bank } = await api<{ bank: Bank }>("/api/banks", {
        method: "POST",
        json: { name: name.trim(), description: description.trim() || undefined, language, allow_model: allowModel, pin_language: pinLanguage, vocab: [] },
      });
      setName("");
      setDescription("");
      onCreated(bank);
    } catch (e) {
      setError(errMsg(e, tr("创建失败", "Could not create the bank")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={tr("新建题库", "New bank")}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="space-y-1.5">
          <FieldLabel htmlFor="nb-name">{tr("名称", "Name")}</FieldLabel>
          <Input id="nb-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder={tr("如：五年级竞赛题", "e.g. Year 5 competition")} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="nb-desc">{tr("说明（可选）", "Description (optional)")}</FieldLabel>
          <Input id="nb-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </div>
        <div className="space-y-1.5">
          <FieldLabel>{tr("题目语言", "Question language")}</FieldLabel>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
        <CheckboxField
          checked={allowModel}
          onChange={setAllowModel}
          hint={tr("关闭后，题库内容不会发送给模型服务（PDF 整理、模板分析和出题将不可用）。", "When off, bank content is never sent to the model service (PDF tidying, template analysis and generation are unavailable).")}
        >
          {tr("允许发送给模型", "Allow sending to the model")}
        </CheckboxField>
        <CheckboxField
          checked={pinLanguage}
          onChange={setPinLanguage}
          hint={tr("否则生成的题目跟随界面语言。", "Otherwise generated questions follow the UI language.")}
        >
          {tr("生成题目使用题库语言", "Generate in the bank's language")}
        </CheckboxField>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {tr("取消", "Cancel")}
          </Button>
          <Button type="submit" loading={busy}>
            {tr("创建", "Create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Bank settings dialog: name, language, model permission, vocabulary, export, delete. */
export function BankSettingsDialog({
  bank,
  open,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  bank: Bank;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: (bank: Bank) => void;
  onDeleted: () => void;
}) {
  const { tr } = useI18n();
  const [name, setName] = useState(bank.name);
  const [description, setDescription] = useState(bank.description ?? "");
  const [language, setLanguage] = useState(bank.language);
  const [allowModel, setAllowModel] = useState(bank.allow_model);
  const [pinLanguage, setPinLanguage] = useState(bank.pin_language);
  const [vocab, setVocab] = useState(bank.vocab.join("\n"));
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const words = [...new Set(vocab.split("\n").map((s) => s.trim()).filter(Boolean))].map((s) => s.slice(0, 80));
      const res = await api<{ bank: Bank }>(bankUrl(bank.id), {
        method: "PATCH",
        json: { name: name.trim() || bank.name, description, language, allow_model: allowModel, pin_language: pinLanguage, vocab: words },
      });
      onSaved(res.bank);
    } catch (e) {
      setError(errMsg(e, tr("保存失败", "Save failed")));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    setError(null);
    try {
      await api(bankUrl(bank.id), { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(errMsg(e, tr("删除失败", "Delete failed")));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={tr("题库设置", "Bank settings")} className="max-w-xl">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="bs-name">{tr("名称", "Name")}</FieldLabel>
            <Input id="bs-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>{tr("题目语言", "Question language")}</FieldLabel>
            <LanguageSelect value={language} onChange={setLanguage} />
          </div>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="bs-desc">{tr("说明", "Description")}</FieldLabel>
          <Input id="bs-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </div>
        <CheckboxField checked={allowModel} onChange={setAllowModel} hint={tr("关闭后，题库内容不会发送给模型服务。", "When off, bank content is never sent to the model service.")}>
          {tr("允许发送给模型", "Allow sending to the model")}
        </CheckboxField>
        <CheckboxField checked={pinLanguage} onChange={setPinLanguage}>
          {tr("生成题目使用题库语言", "Generate in the bank's language")}
        </CheckboxField>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="bs-vocab">{tr("自定义知识点词表（每行一个）", "Custom knowledge-point vocabulary (one per line)")}</FieldLabel>
          <Textarea id="bs-vocab" rows={5} value={vocab} onChange={(e) => setVocab(e.target.value)} className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">{tr("优先于内置课程知识点使用。", "Used before the built-in curriculum list.")}</p>
        </div>
        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-between gap-2">
          <a href={bankUrl(bank.id, "/export")} download className={cn(buttonVariants({ variant: "outline" }), "gap-1.5")}>
            <Download className="h-3.5 w-3.5" />
            {tr("导出 JSONL", "Export JSONL")}
          </a>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {tr("取消", "Cancel")}
            </Button>
            <Button onClick={() => void save()} loading={busy === "save"}>
              {tr("保存", "Save")}
            </Button>
          </div>
        </div>

        <Separator />
        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm font-medium text-destructive">{tr("删除题库", "Delete bank")}</p>
          <p className="text-xs text-muted-foreground">
            {tr(`此操作会删除全部题目、分类和导入记录，无法撤销。输入题库名称“${bank.name}”以确认。`, `This deletes all questions, categories and import records and cannot be undone. Type the bank name "${bank.name}" to confirm.`)}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={bank.name} aria-label={tr("输入题库名称确认删除", "Type the bank name to confirm deletion")} className="h-8" />
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              disabled={confirmName !== bank.name}
              loading={busy === "delete"}
              onClick={() => void remove()}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {tr("永久删除", "Delete permanently")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
