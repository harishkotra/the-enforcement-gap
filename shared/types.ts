export type Arm = 'prompt' | 'gate';

export type RuleId =
  | 'R1_SECRET'
  | 'R2_SCOPE'
  | 'R3_TESTS'
  | 'R4_NOLOG'
  | 'R5_HTTP'
  | 'R6_ORDER';

export interface Check {
  rule: RuleId;
  actionIndex: number;
  ok: boolean;
  detail: string;
}

export interface ActionView {
  index: number;
  tool: 'write_file' | 'run' | 'commit';
  summary: string;
  status: 'applied' | 'blocked' | 'skipped';
  /** The rule this action broke or was stopped by. */
  rule?: RuleId;
  detail?: string;
}

export type Verdict = 'clean' | 'violation' | 'blocked' | 'declined' | 'empty' | 'error';

export interface ArmResult {
  arm: Arm;
  verdict: Verdict;
  actions: ActionView[];
  checks: Check[];
  /** Violations the model was about to commit, whether or not they landed. */
  attempts: number;
  /** Violations that reached the repo. */
  landed: number;
  /** Violations refused by a gate. */
  blocked: number;
  reasoning: string;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  note?: string;
}

export interface Round {
  id: string;
  taskId: string;
  taskTitle: string;
  model: string;
  rep: number;
  status: 'running' | 'done' | 'error';
  prompt?: ArmResult;
  gate?: ArmResult;
  error?: string;
}

export interface ArmTotals {
  rounds: number;
  clean: number;
  roundsWithAttempt: number;
  attempts: number;
  landed: number;
  blocked: number;
  emptyRounds: number;
  ms: number;
  tokens: number;
}

export interface Totals {
  rounds: number;
  prompt: ArmTotals;
  gate: ArmTotals;
  byRule: Record<string, { prompt: number; gate: number }>;
}

export interface ApprovalRequest {
  id: string;
  roundId: string;
  taskTitle: string;
  model: string;
  message: string;
  files: string[];
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
}

/** One model on one endpoint. A run can mix providers. */
export interface Target {
  key: string;
  label: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface RunConfig {
  /** Labels of the models this run used. */
  targets: string[];
  taskIds: string[];
  reps: number;
  humanGate: boolean;
}

export interface RunMeta {
  id: string;
  startedAt: string;
  finishedAt?: string;
  config: RunConfig;
  status: 'running' | 'done' | 'error';
}

export type RunEvent =
  | { type: 'run_start'; run: RunMeta }
  | { type: 'round_start'; round: Round }
  | { type: 'arm_done'; roundId: string; result: ArmResult }
  | { type: 'round_done'; round: Round }
  | { type: 'approval_request'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; approval: ApprovalRequest }
  | { type: 'totals'; totals: Totals; rounds: Round[] }
  | { type: 'run_done'; run: RunMeta; totals: Totals }
  | { type: 'error'; message: string };
