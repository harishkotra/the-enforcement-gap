import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, Round, RunEvent, Totals } from './types';
import type { Config, Provider, SavedRun } from './types';
import { RoundCard } from './components/RoundCard';
import { ModelTable } from './components/ModelTable';
import { SideRail } from './components/SideRail';

type Status = 'idle' | 'running' | 'done' | 'error';

const EMPTY_ARM = {
  rounds: 0,
  clean: 0,
  roundsWithAttempt: 0,
  attempts: 0,
  landed: 0,
  blocked: 0,
  emptyRounds: 0,
  ms: 0,
  tokens: 0,
};

const EMPTY_TOTALS: Totals = { rounds: 0, prompt: EMPTY_ARM, gate: EMPTY_ARM, byRule: {} };

/** A selected model is "provider::model"; the key survives reloads. */
const targetKey = (providerId: string, model: string) => `${providerId}::${model}`;

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [reps, setReps] = useState(2);
  const [humanGate, setHumanGate] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('eg.key') ?? '');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [status, setStatus] = useState<Status>('idle');
  const [rounds, setRounds] = useState<Round[]>([]);
  const [totals, setTotals] = useState<Totals>(EMPTY_TOTALS);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [history, setHistory] = useState<SavedRun[]>([]);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c: Config) => {
        setConfig(c);
        const first = c.providers[0];
        if (first?.models.length) setSelected([targetKey(first.id, first.models[0])]);
        setTaskIds(c.tasks.map((t) => t.id));
      })
      .catch(() => setLog((l) => [...l, 'could not load /api/config']));

    fetch('/api/runs')
      .then((r) => r.json())
      .then((d: { runs: SavedRun[] }) => {
        setHistory(d.runs ?? []);
        if (d.runs?.length) loadSaved(d.runs[0].id);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'running') return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    localStorage.setItem('eg.key', apiKey);
  }, [apiKey]);

  const loadSaved = async (id: string) => {
    try {
      const data = await fetch(`/api/runs/${id}`).then((r) => r.json());
      setRounds(data.rounds ?? []);
      setTotals(data.totals ?? EMPTY_TOTALS);
      setRunId(data.run?.id ?? id);
      setStatus('done');
    } catch {
      setLog((l) => [...l, `could not load ${id}`]);
    }
  };

  const targetsFor = (provider: Provider | undefined, model: string) => ({
    key: targetKey(provider?.id ?? 'custom', model),
    label: model,
    model,
    baseUrl: provider?.baseUrl,
    apiKey: provider?.needsKey ? apiKey : undefined,
  });

  const start = async () => {
    if (!config) return;
    source.current?.close();
    setRounds([]);
    setTotals(EMPTY_TOTALS);
    setApprovals([]);
    setLog([]);
    setStatus('running');

    const targets = selected.flatMap((key) => {
      const [providerId, model] = key.split('::');
      const provider = (config.providers ?? []).find((p) => p.id === providerId);
      if (!provider) return [];
      return [targetsFor(provider, model)];
    });

    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { taskIds, reps, humanGate }, targets, apiKey }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus('error');
      setLog((l) => [...l, body.error ?? `run failed: ${res.status}`]);
      return;
    }
    const { runId: id } = (await res.json()) as { runId: string };
    setRunId(id);

    const es = new EventSource(`/api/run/${id}/stream`);
    source.current = es;
    es.onmessage = (message) => applyEvent(JSON.parse(message.data) as RunEvent);
    es.onerror = () => es.close();
  };

  const applyEvent = (event: RunEvent) => {
    switch (event.type) {
      case 'run_start':
        setLog((l) => [...l, `run ${event.run.id} started · ${event.run.config.targets.join(', ')}`]);
        break;
      case 'round_start':
        setRounds((rs) => [...rs.filter((r) => r.id !== event.round.id), event.round]);
        break;
      case 'arm_done':
        setRounds((rs) => rs.map((r) => (r.id === event.roundId ? { ...r, [event.result.arm]: event.result } : r)));
        break;
      case 'round_done':
        setRounds((rs) => rs.map((r) => (r.id === event.round.id ? { ...r, ...event.round } : r)));
        break;
      case 'approval_request':
        setApprovals((a) => [...a.filter((x) => x.id !== event.approval.id), event.approval]);
        break;
      case 'approval_resolved':
        setApprovals((a) => a.map((x) => (x.id === event.approval.id ? event.approval : x)));
        break;
      case 'totals':
        setTotals(event.totals);
        break;
      case 'run_done':
        setStatus('done');
        setLog((l) => [...l, `run finished · ${event.totals.rounds} rounds`]);
        fetch('/api/runs')
          .then((r) => r.json())
          .then((d: { runs: SavedRun[] }) => setHistory(d.runs ?? []))
          .catch(() => undefined);
        break;
      case 'error':
        setLog((l) => [...l, event.message]);
        break;
    }
  };

  const decide = async (approval: ApprovalRequest, approved: boolean) => {
    if (!runId) return;
    await fetch(`/api/run/${runId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: approval.id, approved }),
    });
  };

  const toggle = (value: string) =>
    setSelected((list) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]));

  const totalRounds = selected.length * taskIds.length * reps;
  const anyKeyNeeded = selected.some((key) => config?.providers.find((p) => p.id === key.split('::')[0])?.needsKey);
  const canRun = status !== 'running' && selected.length > 0 && taskIds.length > 0 && (!anyKeyNeeded || Boolean(apiKey) || config?.envHasKey);

  return (
    <div className="shell">
      <header className="top">
        <div>
          <div className="mark">DailyBuild · Day 298</div>
          <h1>The Enforcement Gap</h1>
          <p className="lede">
            Two coding agents. Same repo, same task, same <b>AGENTS.md</b>. One is <b>told</b> the rules. The other is
            <b> held</b> to them, action by action, before anything lands. The distance between those two runs is
            measured, not asserted.
          </p>
        </div>
        <div className="controls">
          {config?.providers.map((provider) => (
            <div className="field" key={provider.id}>
              <span>{provider.label}</span>
              <div className="chips">
                {provider.models.map((model) => {
                  const key = targetKey(provider.id, model);
                  return (
                    <button
                      key={key}
                      className="chip"
                      data-on={selected.includes(key)}
                      onClick={() => toggle(key)}
                      disabled={status === 'running'}
                      title={model}
                    >
                      {model.replace(':latest', '').split('-').slice(0, 2).join('-')}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="field">
            <span>Tasks</span>
            <select
              value={taskIds.length === (config?.tasks.length ?? 0) ? 'all' : String(taskIds.length)}
              onChange={(e) => {
                if (!config) return;
                if (e.target.value === 'all') setTaskIds(config.tasks.map((t) => t.id));
                else setTaskIds(config.tasks.slice(0, Number(e.target.value)).map((t) => t.id));
              }}
              disabled={status === 'running'}
            >
              <option value="all">all {config?.tasks.length ?? 0}</option>
              {[2, 4, 6].map((n) => (
                <option key={n} value={n}>
                  first {n}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span>Reps / task</span>
            <input
              type="number"
              min={1}
              max={5}
              value={reps}
              onChange={(e) => setReps(Math.min(Math.max(Number(e.target.value) || 1, 1), 5))}
              disabled={status === 'running'}
            />
          </div>
          <div className="field">
            <span>Human gate</span>
            <button className="chip" data-on={humanGate} onClick={() => setHumanGate(!humanGate)} disabled={status === 'running'}>
              {humanGate ? 'on · commits need you' : 'off'}
            </button>
          </div>
          <div className="field">
            <span>
              {totalRounds} rounds · {status === 'running' ? `${elapsed}s` : status}
            </span>
            <button className="run-btn" onClick={start} disabled={!canRun}>
              {status === 'running' ? 'running' : 'Run the experiment'}
            </button>
          </div>
          <div className="field">
            <span>Inference</span>
            <button className="ghost" onClick={() => setSettingsOpen(!settingsOpen)}>
              {apiKey ? 'key set' : config?.envHasKey ? 'key from env' : 'key needed'} · {config?.baseUrl?.replace('https://', '')}
            </button>
          </div>
          {settingsOpen && (
            <div className="field" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Particle (or any OpenAI-compatible) API key"
              />
              <span style={{ color: 'var(--dim)', fontSize: 10.5 }}>
                Stored in this browser only and sent with the run. Local models need no key.
              </span>
            </div>
          )}
        </div>
      </header>

      <section className="verdict">
        <div className="stat" data-tone="amber">
          <div className="k">Rules broken by the model</div>
          <div className="v">{totals.prompt.attempts}</div>
          <div className="s">across {totals.prompt.rounds} told-the-rule rounds</div>
        </div>
        <div className="stat" data-tone="red">
          <div className="k">Violations that landed</div>
          <div className="v">{totals.prompt.landed}</div>
          <div className="s">nobody was checking in this arm</div>
        </div>
        <div className="stat" data-tone="green">
          <div className="k">Refused by a gate</div>
          <div className="v">{totals.gate.blocked}</div>
          <div className="s">same model, same rulebook</div>
        </div>
        <div className="stat" data-tone="green">
          <div className="k">Landed with gates</div>
          <div className="v">{totals.gate.landed}</div>
          <div className="s">the check is code, not a suggestion</div>
        </div>
      </section>
      <p className="footnote">
        The gate arm's zero is by construction: a deterministic check refuses the action. The number worth reading is the
        attempt rate, because that is the model's behaviour. It varies by model, which is the whole problem with
        trusting a paragraph.
      </p>

      <div className="grid">
        <main>
          <div className="section-h">
            <span>Rounds</span>
            <span>
              {rounds.filter((r) => r.status === 'done').length}/{totalRounds} complete
            </span>
          </div>
          {rounds.length === 0 && (
            <div className="round" style={{ padding: 18, color: 'var(--dim)' }}>
              No rounds yet. Pick models, pick tasks, run. Each round is two inference calls: one told, one held.
            </div>
          )}
          {rounds.map((round) => (
            <RoundCard key={round.id} round={round} />
          ))}

          <div className="section-h" style={{ marginTop: 22 }}>
            <span>By model</span>
            <span>the gate is the constant</span>
          </div>
          <ModelTable rounds={rounds} />

          {log.length > 0 && (
            <div className="log">
              {log.slice(-8).map((line, i) => (
                <div key={i}>· {line}</div>
              ))}
            </div>
          )}
        </main>

        <SideRail
          rules={config?.rules ?? []}
          totals={totals}
          approvals={approvals}
          onDecide={decide}
          history={history}
          onLoad={loadSaved}
        />
      </div>

      <footer className="foot">
        <span>
          Built By{' '}
          <a href="https://harishkotra.me" target="_blank" rel="noreferrer">
            Harish Kotra
          </a>
        </span>
        <span>
          <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">
            Checkout my other builds
          </a>
        </span>
      </footer>
    </div>
  );
}
