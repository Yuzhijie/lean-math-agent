import type { z } from "zod";

export class LlmError extends Error {}

export async function chatJson<T>(args: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
}): Promise<T> {
  const first = await rawChat(args.system, args.user);
  const once = tryParse(args.schema, first);
  if (once.ok) return once.value;
  const second = await rawChat(
    args.system,
    `${args.user}\n\nYour previous JSON was invalid for ${args.schemaName}: ${once.error}\nReturn ONLY valid JSON.`,
  );
  const twice = tryParse(args.schema, second);
  if (twice.ok) return twice.value;
  throw new LlmError(`Invalid LLM JSON for ${args.schemaName}: ${twice.error}`);
}

function tryParse<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const json = extractJson(text);
    return { ok: true, value: schema.parse(json) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : trimmed;
  return JSON.parse(raw);
}

async function rawChat(system: string, user: string): Promise<string> {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new LlmError("LLM_API_KEY is not set");
  const base = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const model = process.env.LLM_MODEL ?? "gpt-4.1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new LlmError(`LLM HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("LLM returned empty content");
  return content;
}
