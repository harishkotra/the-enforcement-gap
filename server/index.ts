import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { RULES } from './rules.js';
import { TASKS } from './tasks.js';
import { createRunState, executeRun, resolveApproval } from './runner.js';
import type { RunConfig, RunEvent, Target } from '../shared/types.js';

const PORT = Number(process.env.PORT || 5177);
const ROOT = process.cwd();
const RUNS_DIR = path.join(ROOT, 'runs');

const PARTICLE_MODELS = (process.env.MODELS || 'deepseek-v41-flash-1017,glm5.3flash').split(',').filter(Boolean);
const PARTICLE_BASE = process.env.PARTICLE_BASE_URL || 'https://api.particle.ai/v1';
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';

interface Bus {
  events: RunEvent[];
  subscribers: Set<(event: RunEvent) => void>;
  state: ReturnType<typeof createRunState>;
}

const buses = new Map<string, Bus>();

/** Ollama is optional: the local models are the ones that actually drift. */
async function ollamaModels(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((name) => !/embedding|^nomic|^mxbai/i.test(name))
      .slice(0, 8);
  } catch {
    return [];
  }
}

const isLocal = (baseUrl: string) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/config', async (_req, res) => {
  const local = await ollamaModels();
  res.json({
    providers: [
      { id: 'particle', label: 'Particle', baseUrl: PARTICLE_BASE, needsKey: true, models: PARTICLE_MODELS },
      ...(local.length ? [{ id: 'ollama', label: 'Ollama · local', baseUrl: OLLAMA_BASE, needsKey: false, models: local }] : []),
    ],
    tasks: TASKS.map((t) => ({ id: t.id, title: t.title, prompt: t.prompt, strain: t.strain })),
    rules: RULES,
    baseUrl: PARTICLE_BASE,
    envHasKey: Boolean(process.env.PARTICLE_API_KEY),
  });
});

app.post('/api/run', async (req, res) => {
  const body = req.body as {
    config?: Partial<RunConfig>;
    targets?: Array<Partial<Target>>;
    apiKey?: string;
  };
  const fallbackKey = body.apiKey || process.env.PARTICLE_API_KEY || '';

  const targets: Target[] = [];
  for (const raw of body.targets ?? []) {
    if (!raw?.model) continue;
    const baseUrl = raw.baseUrl || PARTICLE_BASE;
    const apiKey = raw.apiKey || (isLocal(baseUrl) ? undefined : fallbackKey);
    if (!apiKey && !isLocal(baseUrl)) {
      res.status(400).json({ error: `no key for ${baseUrl}: paste one in settings or set PARTICLE_API_KEY` });
      return;
    }
    targets.push({
      key: raw.key || `${raw.model}@${baseUrl}`,
      label: raw.label || raw.model,
      model: raw.model,
      baseUrl,
      apiKey,
    });
  }

  if (!targets.length) {
    res.status(400).json({ error: 'pick at least one model' });
    return;
  }

  const taskIds = body.config?.taskIds?.length ? body.config.taskIds : TASKS.map((t) => t.id);
  const config: RunConfig = {
    targets: targets.map((t) => t.label),
    taskIds,
    reps: Math.min(Math.max(body.config?.reps ?? 2, 1), 5),
    humanGate: Boolean(body.config?.humanGate),
  };

  const state = createRunState(targets, config);
  const bus: Bus = { events: [], subscribers: new Set(), state };
  buses.set(state.meta.id, bus);

  const emit = (event: RunEvent) => {
    bus.events.push(event);
    for (const fn of bus.subscribers) fn(event);
  };

  res.json({ runId: state.meta.id, run: state.meta });

  // Runs outlive the request; the client watches over SSE.
  void executeRun(state, emit).catch((error: unknown) => {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
});

app.get('/api/run/:id/stream', (req, res) => {
  const bus = buses.get(req.params.id);
  if (!bus) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  for (const event of bus.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  const listener = (event: RunEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  bus.subscribers.add(listener);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    bus.subscribers.delete(listener);
  });
});

app.post('/api/run/:id/approve', (req, res) => {
  const bus = buses.get(req.params.id);
  if (!bus) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  const { approvalId, approved } = req.body as { approvalId?: string; approved?: boolean };
  if (!approvalId) {
    res.status(400).json({ error: 'approvalId required' });
    return;
  }
  res.json({ ok: resolveApproval(bus.state, approvalId, Boolean(approved)) });
});

app.get('/api/runs', async (_req, res) => {
  try {
    const files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
    const runs = [];
    for (const file of files.slice(0, 40)) {
      try {
        const data = JSON.parse(await readFile(path.join(RUNS_DIR, file), 'utf8'));
        runs.push({
          id: data.run.id,
          startedAt: data.run.startedAt,
          targets: data.config?.targets ?? data.run?.config?.targets ?? [],
          totals: data.totals,
          config: data.config,
        });
      } catch {
        // a half-written file is not worth breaking the list over
      }
    }
    res.json({ runs });
  } catch {
    res.json({ runs: [] });
  }
});

app.get('/api/runs/:id', async (req, res) => {
  try {
    const data = JSON.parse(await readFile(path.join(RUNS_DIR, `${req.params.id}.json`), 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(ROOT, 'dist');
  const index = path.join(dist, 'index.html');
  if (!existsSync(index)) {
    console.warn('no dist/index.html: `npm start` builds first via prestart; if you skipped it, run `npm run build`');
  }
  app.use(express.static(dist));
  app.get('*', (_req, res) => {
    if (!existsSync(index)) {
      res
        .status(503)
        .type('text/plain')
        .send('No production build found. Run `npm run build` (or `npm start`, which builds first) and reload.');
      return;
    }
    res.sendFile(index);
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, () => {
  console.log(`the enforcement gap -> http://localhost:${PORT}`);
});
