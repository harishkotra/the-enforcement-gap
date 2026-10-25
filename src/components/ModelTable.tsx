import type { Round } from '../types';

/** The part of the result that is about models, not about the app. */
export function ModelTable({ rounds }: { rounds: Round[] }) {
  const done = rounds.filter((r) => r.status === 'done');
  if (done.length === 0) return null;

  const models = [...new Set(done.map((r) => r.model))];
  const rows = models.map((model) => {
    const own = done.filter((r) => r.model === model);
    return {
      model,
      rounds: own.length,
      attempts: own.reduce((n, r) => n + (r.prompt?.attempts ?? 0), 0),
      landed: own.reduce((n, r) => n + (r.prompt?.landed ?? 0), 0),
      blocked: own.reduce((n, r) => n + (r.gate?.blocked ?? 0), 0),
      gateLanded: own.reduce((n, r) => n + (r.gate?.landed ?? 0), 0),
    };
  });

  return (
    <table className="models">
      <thead>
        <tr>
          <th>Model</th>
          <th>Rounds</th>
          <th>Rules broken</th>
          <th>Landed</th>
          <th>Refused</th>
          <th>Landed with gates</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.model}>
            <td className="name">{row.model}</td>
            <td className="num">{row.rounds}</td>
            <td className={row.attempts ? 'num hot' : 'num'}>{row.attempts}</td>
            <td className={row.landed ? 'num hot' : 'num'}>{row.landed}</td>
            <td className={row.blocked ? 'num ok' : 'num'}>{row.blocked}</td>
            <td className={row.gateLanded ? 'num hot' : 'num ok'}>{row.gateLanded}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
