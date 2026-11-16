/** Small pieces shared by the player view and the big screen. */
import { useEffect, useState } from 'preact/hooks';
import type { EndView, FinaleView, PhaseMsg, PopSummary } from '../shared/protocol.ts';
import { HOST_LIMITS, type Settings } from '../shared/settings.ts';
import { hostConfig, hostStart, serverNow, type FeedEntry, type State } from './store.ts';

export function Hearts({ n, max }: { n: number; max?: number }) {
  const total = Math.max(n, max ?? n);
  return (
    <span class="hearts" aria-label={`${n} hearts`}>
      {Array.from({ length: total }, (_, i) => (
        <span class={i < n ? 'heart' : 'heart empty'}>♥</span>
      ))}
    </span>
  );
}

/** Re-renders a few times a second and returns whole seconds until `until` (server time). */
export function useSecondsLeft(until: number | undefined): number {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 200);
    return () => window.clearInterval(id);
  }, []);
  return until === undefined ? 0 : Math.max(0, Math.ceil((until - serverNow()) / 1000));
}

export function Survivors({ s }: { s: State }) {
  const total = s.phase?.total ?? 0;
  return (
    <div class="survivors">
      <b>{s.alive}</b>
      <span> / {total} floating</span>
    </div>
  );
}

export function Feed({ items, limit }: { items: FeedEntry[]; limit: number }) {
  if (items.length === 0) return <div class="feed empty">Claimed answers show up here</div>;
  return (
    <ul class="feed">
      {items.slice(0, limit).map((f) => (
        <li key={f.id} class={f.rare ? 'rare' : ''}>
          <b>{f.answer}</b>
          <span>{f.by}</span>
        </li>
      ))}
    </ul>
  );
}

export function PopCard({ pop, big }: { pop: PopSummary; big?: boolean }) {
  return (
    <div class={`card pop-card ${big ? 'big' : ''}`}>
      {pop.saved ? (
        <>
          <h2>Too close!</h2>
          <p>That pop would have taken everyone out, so nobody loses a heart.</p>
        </>
      ) : (
        <>
          <p class="eyebrow">Round {pop.round} results</p>
          <p class="pop-numbers">
            <span>
              <b>{pop.lost}</b> lost a heart
            </span>
            <span>
              <b>{pop.out}</b> popped out
            </span>
            <span>
              <b>{pop.aliveAfter}</b> still floating
            </span>
          </p>
          {pop.outNames.length > 0 && (
            <p class="muted">
              Goodbye {pop.outNames.join(', ')}
              {pop.out > pop.outNames.length ? ` and ${pop.out - pop.outNames.length} more` : ''}
            </p>
          )}
        </>
      )}
      {pop.rarest && (
        <p class="rarest">
          Rarest answer: <b>{pop.rarest.answer}</b> by {pop.rarest.by}
        </p>
      )}
    </div>
  );
}

export function FinaleLineup({ fin, meId, active }: { fin: FinaleView; meId?: string; active: boolean }) {
  return (
    <ul class="lineup">
      {fin.players.map((p) => (
        <li
          key={p.id}
          class={[p.alive ? '' : 'out', active && p.id === fin.holder ? 'holder' : '', p.id === meId ? 'me' : ''].join(' ')}
        >
          <span class="lineup-name">{p.name}</span>
          {p.alive ? <Hearts n={p.hearts} /> : <span class="muted">out</span>}
        </li>
      ))}
    </ul>
  );
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};
export { ordinal };

export function EndCard({ end, big }: { end: EndView; big?: boolean }) {
  const mins = Math.floor(end.durationMs / 60000);
  const secs = Math.round((end.durationMs % 60000) / 1000);
  return (
    <div class={`end ${big ? 'big' : ''}`}>
      <div class="winner">
        <div class="crown">👑</div>
        <h1>{end.winner ?? 'Nobody'}</h1>
        <p>
          wins against {end.players - 1} {end.players === 2 ? 'other player' : 'others'} in {mins}:{String(secs).padStart(2, '0')}
        </p>
      </div>
      <div class="end-grid">
        <div class="card">
          <h3>Final standings</h3>
          <ol class="standings">
            {end.top.map((r) => (
              <li>
                <span class="place">{ordinal(r.place)}</span>
                <span class="who">{r.name}</span>
                <span class="muted">{r.claims} answers</span>
              </li>
            ))}
          </ol>
        </div>
        <div class="card">
          <h3>Highlights</h3>
          <dl class="stats">
            {end.stats.rarest && (
              <>
                <dt>Rarest answer</dt>
                <dd>
                  <b>{end.stats.rarest.answer}</b> by {end.stats.rarest.by}
                </dd>
              </>
            )}
            {end.stats.most && (
              <>
                <dt>Most answers claimed</dt>
                <dd>
                  <b>{end.stats.most.name}</b> with {end.stats.most.claims}
                </dd>
              </>
            )}
            {end.stats.closest && (
              <>
                <dt>Closest call</dt>
                <dd>
                  <b>{end.stats.closest.name}</b> answered "{end.stats.closest.answer}" with{' '}
                  {(Math.max(0, end.stats.closest.ms) / 1000).toFixed(2)} s left
                </dd>
              </>
            )}
            <dt>Main rounds</dt>
            <dd>{end.rounds}</dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

function Stepper(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  const { label, value, min, max, step, unit, onChange } = props;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div class="stepper">
      <span>{label}</span>
      <div>
        <button type="button" aria-label={`Less ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
          −
        </button>
        <output>
          {value}
          {unit}
        </output>
        <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
          +
        </button>
      </div>
    </div>
  );
}

/** Host-only lobby controls. Every change is sent to the server, which clamps and echoes it. */
export function HostPanel({ s, settings }: { s: State; settings: Settings }) {
  const allPacks = s.packs.map((p) => p.id);
  const active = settings.packs.length ? settings.packs : allPacks;
  const togglePack = (id: string) => {
    const next = active.includes(id) ? active.filter((p) => p !== id) : [...active, id];
    if (next.length === 0) return;
    hostConfig({ packs: next.length === allPacks.length ? [] : next });
  };
  return (
    <div class="card host-panel">
      <h3>Host settings</h3>
      <Stepper label="Max players" value={settings.maxPlayers} min={HOST_LIMITS.maxPlayers[0]} max={HOST_LIMITS.maxPlayers[1]} step={50} onChange={(v) => hostConfig({ maxPlayers: Math.max(2, v) })} />
      <Stepper label="Starting hearts" value={settings.startHearts} min={HOST_LIMITS.startHearts[0]} max={HOST_LIMITS.startHearts[1]} step={1} onChange={(v) => hostConfig({ startHearts: v })} />
      <Stepper label="Fuse" value={Math.round(settings.fuseMs / 1000)} min={HOST_LIMITS.fuseMs[0] / 1000} max={HOST_LIMITS.fuseMs[1] / 1000} step={2} unit=" s" onChange={(v) => hostConfig({ fuseMs: v * 1000 })} />
      <Stepper label="Finale size" value={settings.finaleSize} min={HOST_LIMITS.finaleSize[0]} max={HOST_LIMITS.finaleSize[1]} step={1} onChange={(v) => hostConfig({ finaleSize: v })} />
      <div class="packs">
        <span>Category packs</span>
        <div>
          {s.packs.map((p) => (
            <button type="button" class={`chip ${active.includes(p.id) ? 'on' : ''}`} aria-pressed={active.includes(p.id)} onClick={() => togglePack(p.id)}>
              {p.id} <small>{p.categories}</small>
            </button>
          ))}
        </div>
      </div>
      <button type="button" class="primary big" disabled={s.seats < 2} onClick={hostStart}>
        {s.seats < 2 ? 'Waiting for players…' : `Start with ${s.seats} players`}
      </button>
    </div>
  );
}

export function phaseTitle(p: PhaseMsg): string {
  if (p.finale) return 'Finale';
  return p.round > 0 ? `Round ${p.round}` : 'Get ready';
}
