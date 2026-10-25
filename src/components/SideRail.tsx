import type { ApprovalRequest, RuleMeta, SavedRun, Totals } from '../types';

interface Props {
  rules: RuleMeta[];
  totals: Totals;
  approvals: ApprovalRequest[];
  onDecide: (approval: ApprovalRequest, approved: boolean) => void;
  history: SavedRun[];
  onLoad: (id: string) => void;
}

const label = (id: string) => id.split('_')[0];

export function SideRail({ rules, totals, approvals, onDecide, history, onLoad }: Props) {
  const pending = approvals.filter((a) => a.status === 'pending');
  return (
    <aside>
      <div className="section-h">
        <span>The rulebook</span>
        <span>hits</span>
      </div>
      <div className="rules">
        {rules.map((rule) => {
          const counts = totals.byRule[rule.id] ?? { prompt: 0, gate: 0 };
          return (
            <div className="rule" key={rule.id}>
              <div className="rid">
                {label(rule.id)} · {rule.id.split('_').slice(1).join(' ')}
              </div>
              <div className="rlabel">{rule.label}</div>
              <div className="counts">
                <span>
                  told <b className={counts.prompt ? 'hit' : ''}>{counts.prompt}</b>
                </span>
                <span>
                  gate <b className={counts.gate ? 'hit' : ''}>{counts.gate}</b>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {pending.length > 0 && (
        <div className="approvals">
          <div className="section-h">
            <span>Human gate</span>
            <span>{pending.length} waiting</span>
          </div>
          {pending.map((approval) => (
            <div className="approval" key={approval.id}>
              <div className="t">commit needs a person: “{approval.message}”</div>
              <div className="files">{approval.files.join(' · ') || 'no files listed'}</div>
              <div className="row">
                <button className="ghost" onClick={() => onDecide(approval, true)}>
                  approve
                </button>
                <button className="ghost" onClick={() => onDecide(approval, false)}>
                  refuse
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="approvals">
        <div className="section-h">
          <span>Past runs</span>
          <span>{history.length}</span>
        </div>
        <div className="history">
          {history.length === 0 && <span style={{ color: 'var(--dim)' }}>nothing saved yet</span>}
          {history.slice(0, 12).map((run) => (
            <button key={run.id} onClick={() => onLoad(run.id)} title={run.id}>
              {run.startedAt.slice(5, 16).replace('T', ' ')} · {(run.targets?.[0] ?? 'run').replace(':latest', '').split('-')[0]} ·{' '}
              {run.totals.prompt.landed}/{run.totals.gate.landed} landed
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
