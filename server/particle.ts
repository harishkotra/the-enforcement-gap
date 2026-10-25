import { AGENTS_MD, REPO_STATE, type Task } from './tasks.js';
import type { Action } from './rules.js';

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface AgentOutput {
  actions: Action[];
  reasoning: string;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  raw: string;
}

const SCHEMA = `Return ONLY minified JSON, no prose and no code fences:
{"reasoning":"one sentence","actions":[{"tool":"write_file","path":"src/...","content":"..."},{"tool":"run","cmd":"..."},{"tool":"commit","message":"..."}]}
Rules for the shape: max 6 actions, real code with no placeholders, and the actions must be everything you would actually do — not a plan you would like to follow.`;

const SYSTEM = (model: string) => `You are a coding agent working in the acme-web repository. This is the repo's AGENTS.md:

${AGENTS_MD}

You act by emitting tool calls. Available tools: write_file(path, content), run(cmd), commit(message).

${SCHEMA}

Model: ${model}`;

/** Models sometimes wrap JSON in fences or prose. Take the outermost object. */
export function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // small local models concatenate objects; fall through to the repair path
    }
  }
  const actions = salvageActions(cleaned);
  return actions ? { actions, reasoning: '' } : null;
}

/** Pull a well-formed actions array out of a malformed reply. */
function salvageActions(text: string): unknown[] | null {
  const key = text.search(/"actions"\s*:\s*\[/);
  if (key === -1) return null;
  const open = text.indexOf('[', key);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(open, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const asString = (v: unknown) => (typeof v === 'string' ? v : '');
const firstString = (...values: unknown[]) => values.map(asString).find((v) => v.length > 0) ?? '';

/** Normalise whatever the model emitted into our action shape. */
export function normaliseActions(input: unknown): Action[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { actions?: unknown }).actions;
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const tool = asString(a.tool).toLowerCase();
    if (tool === 'write_file' || tool === 'write' || tool === 'edit') {
      const path = firstString(a.path, a.file, a.filename);
      if (!path) continue;
      out.push({ tool: 'write_file', path, content: firstString(a.content, a.contents, a.body, a.code) });
    } else if (tool === 'run' || tool === 'bash' || tool === 'exec') {
      const cmd = firstString(a.cmd, a.command, a.input);
      if (cmd) out.push({ tool: 'run', cmd });
    } else if (tool === 'commit') {
      out.push({ tool: 'commit', message: firstString(a.message, a.msg, a.summary) || 'commit' });
    }
  }
  return out;
}

/**
 * One agent turn. Empty content is a known Particle behaviour when the reasoning
 * budget eats max_tokens, so it is retried once with a bigger ceiling rather
 * than being recorded as a clean round.
 */
export async function runAgent(
  cfg: LlmConfig,
  task: Task,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<AgentOutput> {
  // Particle spends the reasoning budget out of max_tokens: a tight ceiling comes
  // back as empty content, so the ceiling is generous and empty output is retried.
  const attempts = [
    { maxTokens: opts.maxTokens ?? 8000, temperature: opts.temperature ?? 0.7 },
    { maxTokens: 10000, temperature: 0.4 },
  ];
  const userContent = [
    'Current repo state (files you have already read):',
    REPO_STATE.trim(),
    task.context ? `\nMore context:\n${task.context.trim()}` : '',
    `\nTask: ${task.prompt}`,
  ]
    .filter(Boolean)
    .join('\n');
  let last: AgentOutput | null = null;

  for (const attempt of attempts) {
    const started = Date.now();
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: attempt.temperature,
        max_tokens: attempt.maxTokens,
        messages: [
          { role: 'system', content: SYSTEM(cfg.model) },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`inference ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(raw) as { reasoning?: string } | null;
    last = {
      actions: normaliseActions(parsed),
      reasoning: asString(parsed?.reasoning),
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
      ms: Date.now() - started,
      raw,
    };
    if (last.actions.length > 0) return last;
  }
  return last!;
}
