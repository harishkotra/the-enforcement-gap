import type { ArmResult, Round } from '../types';

const verdictPill = (result: ArmResult | undefined, arm: 'prompt' | 'gate') => {
  if (!result) return <span className="pill">pending</span>;
  if (result.verdict === 'error') return <span className="pill red">error</span>;
  if (result.verdict === 'declined') return <span className="pill green">declined</span>;
  if (result.verdict === 'empty') return <span className="pill">no output</span>;
  if (arm === 'prompt') {
    return result.landed > 0 ? (
      <span className="pill red">{result.landed} landed</span>
    ) : (
      <span className="pill green">clean</span>
    );
  }
  return result.blocked > 0 ? (
    <span className="pill amber">{result.blocked} blocked</span>
  ) : (
    <span className="pill green">clean</span>
  );
};

const Lane = ({ result, arm }: { result: ArmResult | undefined; arm: 'prompt' | 'gate' }) => (
  <div className="lane">
    <div className="lane-h">
      <span>{arm === 'prompt' ? 'told' : 'held'}</span>
      <em>{arm === 'prompt' ? 'AGENTS.md only' : 'checked before it lands'}</em>
    </div>

    {!result && <div className="action"><span className="txt" style={{ color: 'var(--dim)' }}>waiting for the model</span></div>}

    {result?.actions.map((action) => (
      <div
        key={action.index}
        className={`action ${action.status === 'blocked' ? 'blocked' : ''} ${
          action.status === 'applied' && action.rule ? 'violated' : ''
        } ${action.status === 'skipped' ? 'skipped' : ''}`}
      >
        <span className="n">{action.index + 1}</span>
        <span className="txt" title={action.summary}>
          {action.summary}
        </span>
        {action.rule && (
          <span className={`tag ${action.status === 'blocked' ? 'red' : 'red'}`}>
            {action.status === 'blocked' ? 'refused' : 'landed'} · {action.rule.split('_')[0]}
          </span>
        )}
        {!action.rule && action.status === 'applied' && <span className="tag green">ok</span>}
        {action.status === 'skipped' && <span className="tag dim">not reached</span>}
      </div>
    ))}

    {result?.actions.some((a) => a.detail && a.rule) && (
      <div className="reason">
        {result.actions
          .filter((a) => a.detail && a.rule)
          .slice(0, 2)
          .map((a) => (
            <div key={a.index}>
              <b>{a.rule}:</b> {a.detail}
            </div>
          ))}
      </div>
    )}

    {result?.note && <div className="reason">{result.note}</div>}
    {result && (
      <div className="reason">
        <b>{((result.tokensIn + result.tokensOut) / 1000).toFixed(1)}k tok</b> · {(result.ms / 1000).toFixed(1)}s
        {result.reasoning ? ` · “${result.reasoning.slice(0, 120)}${result.reasoning.length > 120 ? '…' : ''}”` : ''}
      </div>
    )}
  </div>
);

export function RoundCard({ round }: { round: Round }) {
  const worst = Math.max(round.prompt?.landed ?? 0, round.gate?.blocked ?? 0);
  return (
    <article className="round">
      <div className="round-h">
        <span className="t">{round.taskTitle}</span>
        {worst > 0 && <span className="pill amber">{round.prompt?.landed ? 'gap' : 'gate fired'}</span>}
        <span className="m">
          {round.model} · rep {round.rep + 1}
        </span>
        {verdictPill(round.prompt, 'prompt')}
        {verdictPill(round.gate, 'gate')}
      </div>
      <div className="lanes">
        <Lane result={round.prompt} arm="prompt" />
        <Lane result={round.gate} arm="gate" />
      </div>
    </article>
  );
}
