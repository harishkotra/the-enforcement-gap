import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkActions, violationsOf, RULES, EXISTING_PATHS } from './rules.js';
import type { Action } from './rules.js';
import { runAgent } from './particle.js';
import { TASKS, type Task } from './tasks.js';
import type {
  ArmResult,
  ApprovalRequest,
  Round,
  RunConfig,
  RunEvent,
  RunMeta,
  Target,
  Totals,
} from '../shared/types.js';

type Emit = (event: RunEvent) => void;

interface RunState {
  meta: RunMeta;
  rounds: Round[];
  approvals: Map<string, (approved: boolean) => void>;
  config: RunConfig;
  targets: Target[];
}

const RUNS_DIR = path.resolve(process.cwd(), 'runs');
const CONCURRENCY = 3;
const APPROVAL_TIMEOUT_MS = 90_000;

const emptyTotals = (): Totals['prompt'] => ({
  rounds: 0,
  clean: 0,
  roundsWithAttempt: 0,
  attempts: 0,
  landed: 0,
  blocked: 0,
  emptyRounds: 0,
  ms: 0,
  tokens: 0,
});

export function summarise(rounds: Round[]): Totals {
  const totals: Totals = { rounds: rounds.length, prompt: emptyTotals(), gate: emptyTotals(), byRule: {} };
  for (const rule of RULES) totals.byRule[rule.id] = { prompt: 0, gate: 0 };

  for (const round of rounds) {
    for (const arm of ['prompt', 'gate'] as const) {
      const result = round[arm];
      if (!result || result.verdict === 'error') continue;
      const bucket = totals[arm];
      bucket.rounds += 1;
      if (result.verdict === 'empty' || result.verdict === 'declined') bucket.emptyRounds += 1;
      if (result.attempts === 0) bucket.clean += 1;
      else bucket.roundsWithAttempt += 1;
      bucket.attempts += result.attempts;
      bucket.landed += result.landed;
      bucket.blocked += result.blocked;
      bucket.ms += result.ms;
      bucket.tokens += result.tokensIn + result.tokensOut;
      for (const check of result.checks) {
        if (!check.ok) totals.byRule[check.rule][arm] += 1;
      }
    }
  }
  return totals;
}

const summariseAction = (action: Action): string => {
  if (action.tool === 'write_file') return `write_file ${action.path}`;
  if (action.tool === 'run') return `run ${action.cmd}`;
  return `commit "${action.message}"`;
};

/**
 * The prompt arm. Nothing stands between the model and the repo: every action is
 * applied, so every violation it emits lands.
 */
async function runPromptArm(llm: Target, round: Round, task: Task): Promise<ArmResult> {
  const out = await runAgent(llm, task);
  const checks = checkActions(out.actions, EXISTING_PATHS);
  const violations = violationsOf(checks);
  const blockedAt = new Map<number, string>();
  for (const v of violations) blockedAt.set(v.actionIndex, v.detail);

  if (out.actions.length === 0) {
    return {
      arm: 'prompt',
      verdict: out.reasoning ? 'declined' : 'empty',
      actions: [],
      checks,
      attempts: 0,
      landed: 0,
      blocked: 0,
      reasoning: out.reasoning,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      ms: out.ms,
      note: out.reasoning ? 'the model declined the task and did nothing' : 'the model returned no parseable actions',
    };
  }

  return {
    arm: 'prompt',
    verdict: violations.length ? 'violation' : 'clean',
    actions: out.actions.map((action, index) => ({
      index,
      tool: action.tool,
      summary: summariseAction(action),
      status: 'applied',
      rule: violations.find((v) => v.actionIndex === index)?.rule,
      detail: blockedAt.get(index),
    })),
    checks,
    attempts: violations.length,
    landed: violations.length,
    blocked: 0,
    reasoning: out.reasoning,
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    ms: out.ms,
  };
}

/**
 * The gate arm. Same model, same prompt, same AGENTS.md. The only difference is
 * that every action is checked before it is applied, and the first violation
 * stops the run with a named reason.
 */
async function runGateArm(
  llm: Target,
  round: Round,
  task: Task,
  state: RunState,
  emit: Emit,
): Promise<ArmResult> {
  const out = await runAgent(llm, task);
  if (out.actions.length === 0) {
    return {
      arm: 'gate',
      verdict: out.reasoning ? 'declined' : 'empty',
      actions: [],
      checks: [],
      attempts: 0,
      landed: 0,
      blocked: 0,
      reasoning: out.reasoning,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      ms: out.ms,
      note: out.reasoning ? 'the model declined the task and did nothing' : 'the model returned no parseable actions',
    };
  }

  // Checks depend on the whole action list (sibling tests, ordering), so the
  // gate is evaluated up front and then applied action by action.
  const checks = checkActions(out.actions, EXISTING_PATHS);
  const violations = violationsOf(checks);
  const firstViolation = violations.length ? Math.min(...violations.map((v) => v.actionIndex)) : Infinity;
  const views: ArmResult['actions'] = [];
  let blocked = 0;
  let halted = false;

  for (let index = 0; index < out.actions.length; index += 1) {
    const action = out.actions[index];
    if (halted) {
      views.push({ index, tool: action.tool, summary: summariseAction(action), status: 'skipped', detail: 'not reached' });
      continue;
    }

    const violation = violations.find((v) => v.actionIndex === index);
    if (violation) {
      blocked += 1;
      halted = true;
      views.push({
        index,
        tool: action.tool,
        summary: summariseAction(action),
        status: 'blocked',
        rule: violation.rule,
        detail: violation.detail,
      });
      continue;
    }

    if (action.tool === 'commit' && state.config.humanGate) {
      const approval = await requestApproval(state, emit, round, action, out.actions);
      if (!approval) {
        blocked += 1;
        halted = true;
        views.push({
          index,
          tool: action.tool,
          summary: summariseAction(action),
          status: 'blocked',
          rule: 'R6_ORDER',
          detail: 'human gate declined the commit',
        });
        continue;
      }
    }

    views.push({ index, tool: action.tool, summary: summariseAction(action), status: 'applied' });
  }

  return {
    arm: 'gate',
    verdict: blocked > 0 ? 'blocked' : 'clean',
    actions: views,
    checks,
    attempts: violations.length,
    landed: 0,
    blocked,
    reasoning: out.reasoning,
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    ms: out.ms,
    note: firstViolation === Infinity ? undefined : `stopped at action ${firstViolation + 1}`,
  };
}

/** Relay's human gate, wearing a browser: the run parks until a person answers. */
async function requestApproval(
  state: RunState,
  emit: Emit,
  round: Round,
  action: Extract<Action, { tool: 'commit' }>,
  all: Action[],
): Promise<boolean> {
  const approval: ApprovalRequest = {
    id: randomUUID(),
    roundId: round.id,
    taskTitle: round.taskTitle,
    model: round.model,
    message: action.message,
    files: all.filter((a) => a.tool === 'write_file').map((a) => a.path),
    status: 'pending',
    requestedAt: new Date().toISOString(),
  };
  emit({ type: 'approval_request', approval });

  const decision = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      state.approvals.delete(approval.id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    state.approvals.set(approval.id, (approved) => {
      clearTimeout(timer);
      state.approvals.delete(approval.id);
      resolve(approved);
    });
  });

  const resolved: ApprovalRequest = { ...approval, status: decision ? 'approved' : 'denied' };
  emit({ type: 'approval_resolved', approval: resolved });
  return decision;
}

export function resolveApproval(state: RunState, id: string, approved: boolean): boolean {
  const fn = state.approvals.get(id);
  if (!fn) return false;
  fn(approved);
  return true;
}

export function createRunState(targets: Target[], config: RunConfig): RunState {
  const meta: RunMeta = {
    id: new Date().toISOString().replace(/[:.]/g, '-'),
    startedAt: new Date().toISOString(),
    config,
    status: 'running',
  };
  return { meta, rounds: [], approvals: new Map(), config, targets };
}

export async function executeRun(state: RunState, emit: Emit): Promise<void> {
  const tasks = TASKS.filter((t) => state.config.taskIds.includes(t.id));
  const queue: Array<{ task: (typeof tasks)[number]; target: Target; rep: number }> = [];
  for (const target of state.targets) {
    for (const task of tasks) {
      for (let rep = 0; rep < state.config.reps; rep += 1) queue.push({ task, target, rep });
    }
  }

  emit({ type: 'run_start', run: state.meta });

  const runOne = async (job: (typeof queue)[number]) => {
    const round: Round = {
      id: randomUUID(),
      taskId: job.task.id,
      taskTitle: job.task.title,
      model: job.target.label,
      rep: job.rep,
      status: 'running',
    };
    state.rounds.push(round);
    emit({ type: 'round_start', round });

    try {
      round.prompt = await runPromptArm(job.target, round, job.task);
      emit({ type: 'arm_done', roundId: round.id, result: round.prompt });

      round.gate = await runGateArm(job.target, round, job.task, state, emit);
      emit({ type: 'arm_done', roundId: round.id, result: round.gate });
      round.status = 'done';
    } catch (error) {
      round.status = 'error';
      round.error = error instanceof Error ? error.message : String(error);
      emit({ type: 'error', message: `${round.taskTitle}: ${round.error}` });
    }

    emit({ type: 'round_done', round });
    emit({ type: 'totals', totals: summarise(state.rounds), rounds: state.rounds });
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (cursor < queue.length) {
      const job = queue[cursor];
      cursor += 1;
      await runOne(job);
    }
  });
  await Promise.all(workers);

  state.meta.status = 'done';
  state.meta.finishedAt = new Date().toISOString();
  const totals = summarise(state.rounds);
  emit({ type: 'run_done', run: state.meta, totals });

  await persist(state, totals);
}

async function persist(state: RunState, totals: Totals) {
  try {
    await mkdir(RUNS_DIR, { recursive: true });
    const file = path.join(RUNS_DIR, `${state.meta.id}.json`);
    await writeFile(
      file,
      JSON.stringify(
        {
          run: state.meta,
          config: state.config,
          targets: state.targets.map((t) => ({ ...t, apiKey: undefined })),
          totals,
          rounds: state.rounds,
        },
        null,
        2,
      ),
    );
  } catch {
    // Persisting is a convenience, never a reason to fail a run.
  }
}
