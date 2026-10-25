export type {
  ActionView,
  Arm,
  ArmResult,
  Check,
  Round,
  RuleId,
  Target,
  Totals,
  ApprovalRequest,
  RunEvent,
  Verdict,
} from '../shared/types';

export interface RuleMeta {
  id: string;
  label: string;
  text: string;
}

export interface TaskMeta {
  id: string;
  title: string;
  prompt: string;
  strain: string[];
}

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  models: string[];
}

export interface Config {
  providers: Provider[];
  tasks: TaskMeta[];
  rules: RuleMeta[];
  baseUrl: string;
  envHasKey: boolean;
}

export interface SavedRun {
  id: string;
  startedAt: string;
  targets: string[];
  totals: import('../shared/types').Totals;
  config: { targets: string[]; taskIds: string[]; reps: number; humanGate: boolean };
}
