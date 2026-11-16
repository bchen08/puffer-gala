import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { EndCard, FinaleLineup, HostPanel, PopCard, phaseTitle, useSecondsLeft } from './parts.tsx';
import { Puffer } from './Puffer.tsx';
import { connect, disconnect, dropReaction, hostAgain, useStore, type FeedEntry, type State } from './store.ts';

function Qr({ text }: { text: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { d, n };
  }, [text]);
  return (
    <svg class="qr" viewBox={`-2 -2 ${path.n + 4} ${path.n + 4}`} role="img" aria-label={`QR code for ${text}`}>
      <rect x="-2" y="-2" width={path.n + 4} height={path.n + 4} fill="#fff" rx="1.5" />
      <path d={path.d} fill="#06243a" />
    </svg>
  );
}

/** Answers fall down the screen. Only the newest few dozen exist at any time. */
function Rain({ items }: { items: FeedEntry[] }) {
  return (
    <div class="rain" aria-hidden="true">
      {items.slice(0, 20).map((f) => (
        <span
          key={f.id}
          class={`drop ${f.rare ? 'rare' : ''}`}
          style={{ left: `${(f.id * 37) % 86}%`, animationDuration: `${5 + (f.id % 5)}s`, fontSize: `${1 + (f.id % 3) * 0.25}em` }}
        >
          {f.answer}
          <small>{f.by}</small>
        </span>
      ))}
    </div>
  );
}

function Reactions({ s }: { s: State }) {
  return (
    <div class="float-reactions" aria-hidden="true">
      {s.reactions.map((r) => (
        <span key={r.id} style={{ left: `${(r.id * 53) % 90}%` }} onAnimationEnd={() => dropReaction(r.id)}>
          {r.e}
        </span>
      ))}
    </div>
  );
}

function ScreenBody({ s }: { s: State }) {
  const p = s.phase!;
  const seconds = useSecondsLeft(p.until);
  const joinUrl = `${location.origin}/r/${s.code}`;

  if (p.ph === 'lobby') {
    return (
      <div class="screen-lobby">
        <div class="join-panel">
          <p class="eyebrow">Join on your phone</p>
          <Qr text={joinUrl} />
          <div class="join-url">{joinUrl.replace(/^https?:\/\//, '')}</div>
          <div class="code huge">{s.code}</div>
        </div>
        <div class="lobby-side">
          <div class="count huge">
            <b>{s.seats}</b>
            <span>{s.seats === 1 ? 'player' : 'players'} ready</span>
          </div>
          <div class="chips">
            {s.joins.map((n, i) => (
              <span class="chip static" key={`${n}-${i}`}>
                {n}
              </span>
            ))}
          </div>
          {s.host && p.settings ? <HostPanel s={s} settings={p.settings} /> : <p class="muted">The host starts the game.</p>}
        </div>
      </div>
    );
  }
  if (p.ph === 'ended' && p.end) {
    return (
      <div class="screen-center">
        <EndCard end={p.end} big />
        {s.host && (
          <button type="button" class="primary big" onClick={hostAgain}>
            Play again
          </button>
        )}
      </div>
    );
  }
  if (p.finale && p.fin) {
    const holder = p.fin.players.find((x) => x.id === p.fin!.holder);
    return (
      <div class="screen-center">
        <p class="eyebrow">Finale · pass the puffer</p>
        <h1 class="prompt huge">{p.cat?.prompt}</h1>
        {p.ph === 'finale' ? (
          <>
            <Puffer startedAt={p.startedAt} deadline={p.deadline} timer />
            <div class="turn huge">{holder?.name} has the puffer</div>
          </>
        ) : (
          <>
            <Puffer popped={!!p.pop} />
            <div class="turn huge">{p.pop ? `It popped on ${p.pop.holder}!${p.pop.out ? ' Out!' : ''}` : `${p.fin.last ? 'New category' : 'The finale begins'} in ${seconds}`}</div>
          </>
        )}
        {p.fin.last && (
          <p class="last-answer">
            <b>{p.fin.last.answer}</b> — {p.fin.last.by}
          </p>
        )}
        <FinaleLineup fin={p.fin} active={p.ph === 'finale'} />
      </div>
    );
  }
  if (p.ph === 'countdown') {
    return (
      <div class="screen-center">
        <p class="eyebrow">{p.round === 0 ? 'Game starting' : 'Next round'}</p>
        <div class="big-count huge">{seconds}</div>
        <p class="muted big-text">Type an answer nobody else has claimed before the puffer pops.</p>
      </div>
    );
  }
  if (p.ph === 'reveal') {
    return (
      <div class="screen-center">
        <Puffer popped />
        {p.pop && <PopCard pop={p.pop} big />}
        <p class="muted big-text">Next round in {seconds}…</p>
      </div>
    );
  }
  // round
  const share = s.alive ? Math.min(1, s.answered / s.alive) : 0;
  return (
    <div class="screen-center">
      <h1 class="prompt huge">{p.cat?.prompt}</h1>
      <Puffer startedAt={p.startedAt} deadline={p.deadline} timer />
      <div class="safe-meter" role="img" aria-label={`${s.answered} of ${s.alive} safe`}>
        <div style={{ width: `${share * 100}%` }} />
        <span>
          <b>{s.answered}</b> of {s.alive} safe
        </span>
      </div>
    </div>
  );
}

export function ScreenView({ code }: { code: string }) {
  const s = useStore();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/rooms/${code}`).then((r) => {
      if (cancelled) return;
      if (r.ok) connect(code, 'screen');
      else setMissing(true);
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [code]);

  if (missing) {
    return (
      <main class="stack">
        <div class="card center">
          <h2>No room called {code}</h2>
          <a class="primary big link" href="/">Back to start</a>
        </div>
      </main>
    );
  }
  if (!s.phase) return <main class="stack center"><p class="muted">Connecting…</p></main>;
  const p = s.phase;
  const playing = p.ph !== 'lobby' && p.ph !== 'ended';
  return (
    <main class="screen">
      <header class="screen-bar">
        <span class="brand">Puff Royale</span>
        <span class="bar-title">{p.ph === 'lobby' ? 'Lobby' : p.ph === 'ended' ? 'Game over' : phaseTitle(p)}</span>
        {playing && (
          <span class="survivors">
            <b>{s.alive}</b> / {p.total} floating
          </span>
        )}
        <span class="join-hint">
          Join at <b>{location.host}</b> · code <b>{s.code}</b>
        </span>
      </header>
      {p.ph === 'round' && <Rain items={s.feed} />}
      <ScreenBody s={s} />
      <Reactions s={s} />
      {s.conn === 'reconnecting' && <div class="toast">Reconnecting…</div>}
    </main>
  );
}
