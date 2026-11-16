import { render } from 'preact';
import { useState } from 'preact/hooks';
import { PlayerView } from './PlayerView.tsx';
import { Puffer } from './Puffer.tsx';
import { ScreenView } from './ScreenView.tsx';
import { hostKeyKey, save } from './store.ts';
import './styles.css';

function Home() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const create = async () => {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not create a room.');
      // The host key stays in this browser; it is what makes this device the host.
      save(hostKeyKey(body.code), body.hostKey);
      location.href = `/r/${body.code}`;
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not create a room.');
      setBusy(false);
    }
  };

  const clean = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  return (
    <main class="stack home">
      <div class="hero">
        <Puffer />
        <h1>Puff Royale</h1>
        <p>One category. One fuse. Hundreds of players. Name something nobody else has, before the puffer pops.</p>
      </div>
      <form
        class="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (clean.length === 4) location.href = `/r/${clean}`;
        }}
      >
        <label class="field">
          <span>Have a code?</span>
          <input
            class="code-input"
            value={clean}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            placeholder="ABCD"
            maxLength={4}
            autocapitalize="characters"
            autocomplete="off"
            spellcheck={false}
          />
        </label>
        <button type="submit" class="primary big" disabled={clean.length !== 4}>
          Join game
        </button>
      </form>
      <div class="card center">
        <p class="muted">Running the game?</p>
        <button type="button" class="ghost big" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Host a new room'}
        </button>
        {problem && <p class="bad">{problem}</p>}
      </div>
    </main>
  );
}

function App() {
  const m = /^\/r\/([A-Za-z]{4})(\/screen)?\/?$/.exec(location.pathname);
  if (!m) return <Home />;
  const code = m[1].toUpperCase();
  return m[2] ? <ScreenView code={code} /> : <PlayerView code={code} />;
}

render(<App />, document.getElementById('app')!);
