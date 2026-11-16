import { useEffect, useRef, useState } from 'preact/hooks';
import { MAX_NAME_CHARS, REACTIONS } from '../shared/protocol.ts';
import { EndCard, Feed, FinaleLineup, Hearts, HostPanel, PopCard, Survivors, ordinal, phaseTitle, useSecondsLeft } from './parts.tsx';
import { Puffer } from './Puffer.tsx';
import { connect, disconnect, hostAgain, load, react, save, submit, tokenKey, useStore, type Feedback, type State } from './store.ts';

function feedbackText(f: Feedback): { tone: string; text: string } {
  switch (f.status) {
    case 'ok':
      return { tone: 'good', text: f.rare ? `${f.answer} — rare! +1 heart` : `${f.answer} — safe!` };
    case 'taken':
      return { tone: 'warn', text: `${f.answer} was taken by ${f.by}` };
    case 'invalid':
      return { tone: 'bad', text: `"${f.text}" isn't on the list` };
    case 'already':
      return { tone: 'good', text: `You're already safe with ${f.answer}` };
    case 'rate':
      return { tone: 'warn', text: 'Slow down a moment' };
    case 'notturn':
      return { tone: 'warn', text: "It's not your turn" };
    case 'closed':
      return { tone: 'bad', text: 'Too late!' };
    default:
      return { tone: 'bad', text: "You're watching this one" };
  }
}

function AnswerBox({ s, enabled, placeholder }: { s: State; enabled: boolean; placeholder: string }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const fb = s.feedback;

  // Clear the box once an answer is judged, so the next try starts clean.
  useEffect(() => {
    if (fb && fb.status !== 'rate') setText('');
  }, [fb?.at]);
  useEffect(() => {
    if (enabled) input.current?.focus({ preventScroll: true });
  }, [enabled, s.phase?.startedAt]);

  const shown = fb ? feedbackText(fb) : null;
  return (
    <form
      class="answer"
      onSubmit={(e) => {
        e.preventDefault();
        if (enabled) submit(text);
        input.current?.focus({ preventScroll: true });
      }}
    >
      <div class={`feedback ${shown?.tone ?? ''}`} role="status" aria-live="polite">
        {shown?.text ?? ' '}
      </div>
      <div class="answer-row">
        <input
          ref={input}
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          placeholder={placeholder}
          disabled={!enabled}
          maxLength={60}
          enterkeyhint="send"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          aria-label="Your answer"
        />
        <button type="submit" class="primary" disabled={!enabled || s.pending || !text.trim()}>
          {s.pending ? '…' : 'Send'}
        </button>
      </div>
    </form>
  );
}

function ReactionBar() {
  return (
    <div class="reaction-bar" aria-label="Send a reaction to the big screen">
      {REACTIONS.map((e) => (
        <button type="button" onClick={() => react(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}

function Lobby({ s }: { s: State }) {
  const link = `${location.origin}/r/${s.code}`;
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Puff Royale', url: link });
      else await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* share sheet dismissed */
    }
  };
  return (
    <main class="stack lobby">
      <div class="card center">
        <p class="eyebrow">Room code</p>
        <div class="code">{s.code}</div>
        <button type="button" class="ghost" onClick={share}>
          {copied ? 'Link copied' : 'Share invite link'}
        </button>
      </div>
      <div class="card center">
        <div class="count">
          <b>{s.seats}</b> {s.seats === 1 ? 'player' : 'players'} in the room
        </div>
        <div class="chips">
          {s.joins.map((n, i) => (
            <span class="chip static" key={`${n}-${i}`}>
              {n}
            </span>
          ))}
        </div>
        {!s.host && <p class="muted">You're in as <b>{s.me?.name}</b>. Waiting for the host to start…</p>}
      </div>
      {s.host && s.phase?.settings && <HostPanel s={s} settings={s.phase.settings} />}
      {s.host && (
        <a class="ghost link" href={`/r/${s.code}/screen`} target="_blank" rel="noopener">
          Open the big-screen view ↗
        </a>
      )}
    </main>
  );
}

function Game({ s }: { s: State }) {
  const p = s.phase!;
  const me = s.me;
  const alive = me?.status === 'alive';
  const seconds = useSecondsLeft(p.until);
  const maxHearts = p.maxHearts;

  let body;
  if (p.ph === 'countdown' && !p.finale) {
    body = (
      <section class="stage center">
        <p class="eyebrow">{p.round === 0 ? 'Game starting' : 'Next round'}</p>
        <div class="big-count">{seconds}</div>
        <p class="muted">Type an answer nobody else has claimed before the puffer pops.</p>
      </section>
    );
  } else if (p.ph === 'round') {
    const safe = !!me?.answer;
    body = (
      <>
        <section class="stage">
          <h1 class="prompt">{p.cat?.prompt}</h1>
          <Puffer startedAt={p.startedAt} deadline={p.deadline} timer />
          <div class="progress-line">
            <b>{s.answered}</b> of {s.alive} safe
            {p.pressure > 0 && <span class="pressure"> · fuse shortened</span>}
          </div>
        </section>
        {alive &&
          (safe ? (
            <div class="safe-banner">
              Safe with <b>{me!.answer}</b>
              {s.feedback?.status === 'ok' && s.feedback.rare ? ' — rare answer, +1 heart' : ''}
            </div>
          ) : (
            <AnswerBox s={s} enabled placeholder="Type an answer…" />
          ))}
        {s.taken.length > 0 && !safe && (
          <div class="taken">
            <span>Taken:</span>
            {s.taken.slice(0, 6).map((t) => (
              <span class="chip static struck" key={t.answer}>
                {t.answer}
              </span>
            ))}
          </div>
        )}
        <Feed items={s.feed} limit={alive ? 6 : 12} />
      </>
    );
  } else if (p.ph === 'reveal') {
    const out = me?.status === 'out' && p.pop && me.place > 0 && p.pop.out > 0 && me.place === p.pop.aliveAfter + 1;
    body = (
      <section class="stage center">
        <Puffer popped />
        {p.pop && <PopCard pop={p.pop} />}
        {alive && me && <p class="you-line">You have <Hearts n={me.hearts} max={maxHearts} /></p>}
        {out && <p class="you-line bad">You popped out in {ordinal(me!.place)} place.</p>}
        <p class="muted">Next round in {seconds}…</p>
      </section>
    );
  } else if (p.finale && p.fin) {
    const myTurn = p.ph === 'finale' && p.fin.holder === me?.id && alive;
    const holder = p.fin.players.find((x) => x.id === p.fin!.holder);
    body = (
      <>
        <section class="stage">
          <p class="eyebrow">Finale · pass the puffer</p>
          <h1 class="prompt">{p.cat?.prompt}</h1>
          {p.ph === 'finale' ? (
            <>
              <Puffer startedAt={p.startedAt} deadline={p.deadline} timer />
              <div class={`turn ${myTurn ? 'mine' : ''}`}>{myTurn ? 'YOUR TURN — answer now!' : `${holder?.name ?? '…'} has the puffer`}</div>
            </>
          ) : (
            <>
              <Puffer popped={!!p.pop} />
              <div class="turn">
                {p.pop ? `It popped on ${p.pop.holder}!${p.pop.out ? ' They are out.' : ''}` : p.fin.last ? 'New category' : 'The finale begins'} · {seconds}
              </div>
            </>
          )}
          {p.fin.last && <p class="muted">Last answer: <b>{p.fin.last.answer}</b> by {p.fin.last.by}</p>}
        </section>
        <FinaleLineup fin={p.fin} meId={me?.id} active={p.ph === 'finale'} />
        {myTurn && <AnswerBox s={s} enabled placeholder="Quick! Type an answer…" />}
      </>
    );
  } else if (p.ph === 'ended' && p.end) {
    body = (
      <section class="stage">
        <EndCard end={p.end} />
        {me && me.place > 0 && (
          <p class="you-line">
            You finished <b>{ordinal(me.place)}</b> of {p.end.players} with {me.claims} answers.
          </p>
        )}
        {s.host ? (
          <button type="button" class="primary big" onClick={hostAgain}>
            Play again
          </button>
        ) : (
          <p class="muted center">Waiting for the host to start another game…</p>
        )}
      </section>
    );
  }

  const watching = !alive && p.ph !== 'ended';
  return (
    <main class="game">
      <header class="bar">
        <span class="bar-title">{phaseTitle(p)}</span>
        <Survivors s={s} />
        {alive && me ? <Hearts n={me.hearts} max={maxHearts} /> : <span class="badge">watching</span>}
      </header>
      {watching && (
        <div class="spectator-note">
          {me?.status === 'out' ? `You're out (${ordinal(me.place)} place). ` : "You'll play in the next game. "}
          Cheer them on:
          <ReactionBar />
        </div>
      )}
      {body}
    </main>
  );
}

function NameForm({ code, onJoin, problem }: { code: string; onJoin: (name: string) => void; problem?: string }) {
  const [name, setName] = useState(load('puff:name') ?? '');
  return (
    <main class="stack">
      <form
        class="card center"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          save('puff:name', n);
          onJoin(n);
        }}
      >
        <p class="eyebrow">Joining room</p>
        <div class="code">{code}</div>
        <label class="field">
          <span>Your name</span>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} maxLength={MAX_NAME_CHARS} autocomplete="nickname" autofocus />
        </label>
        {problem && <p class="bad">{problem}</p>}
        <button type="submit" class="primary big" disabled={!name.trim()}>
          Join the game
        </button>
      </form>
    </main>
  );
}

export function PlayerView({ code }: { code: string }) {
  const s = useStore();
  const [exists, setExists] = useState<boolean | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/rooms/${code}`)
      .then((r) => {
        if (cancelled) return;
        setExists(r.ok);
        // A saved token means this browser already has a seat: go straight back in.
        if (r.ok && load(tokenKey(code))) {
          setJoining(true);
          connect(code, 'player', load('puff:name') ?? undefined);
        }
      })
      .catch(() => !cancelled && setExists(false));
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [code]);

  if (exists === null) return <main class="stack center"><p class="muted">Finding room {code}…</p></main>;
  if (exists === false) {
    return (
      <main class="stack">
        <div class="card center">
          <h2>No room called {code}</h2>
          <p class="muted">Check the code, or the game may have ended.</p>
          <a class="primary big link" href="/">Back to start</a>
        </div>
      </main>
    );
  }

  const needName = !joining || s.error?.code === 'name';
  if (needName || (s.error?.code === 'full' && !s.phase)) {
    return (
      <NameForm
        code={code}
        problem={s.error?.code === 'full' || s.error?.code === 'name' ? s.error.msg : undefined}
        onJoin={(name) => {
          setJoining(true);
          connect(code, 'player', name);
        }}
      />
    );
  }
  if (s.error && (s.error.code === 'replaced' || s.error.code === 'gone')) {
    return (
      <main class="stack">
        <div class="card center">
          <h2>{s.error.code === 'replaced' ? 'Playing in another tab' : 'Room closed'}</h2>
          <p class="muted">{s.error.msg}</p>
          <button type="button" class="primary" onClick={() => location.reload()}>
            {s.error.code === 'replaced' ? 'Play here instead' : 'Reload'}
          </button>
        </div>
      </main>
    );
  }
  if (!s.phase) return <main class="stack center"><p class="muted">Connecting…</p></main>;

  return (
    <>
      {s.conn === 'reconnecting' && <div class="toast">Reconnecting…</div>}
      {s.error && (s.error.code === 'nothost' || s.error.code === 'needplayers') && <div class="toast">{s.error.msg}</div>}
      {s.phase.ph === 'lobby' ? <Lobby s={s} /> : <Game s={s} />}
    </>
  );
}
