import { useEffect, useRef } from 'preact/hooks';
import { serverNow } from './store.ts';

interface Props {
  /** Server timestamps. When absent the puffer idles. */
  startedAt?: number;
  deadline?: number;
  /** Show the burst instead of the fish. */
  popped?: boolean;
  /** Show the seconds left under the fish. */
  timer?: boolean;
}

const SPIKES = Array.from({ length: 16 }, (_, i) => (i * 360) / 16);

/**
 * The puffer inflates from the server clock, not from tick messages: a requestAnimationFrame
 * loop writes CSS variables directly, so it stays smooth and costs no component re-renders.
 */
export function Puffer({ startedAt, deadline, popped, timer }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    const frame = () => {
      const now = serverNow();
      let p = 0;
      let left = 0;
      if (startedAt !== undefined && deadline !== undefined && deadline > startedAt) {
        p = Math.min(1, Math.max(0, (now - startedAt) / (deadline - startedAt)));
        left = Math.max(0, deadline - now);
      }
      // Wobble gets faster and wider as the fuse burns down.
      const wobble = Math.sin(now / (150 - 100 * p)) * (1 + 6 * p * p);
      el.style.setProperty('--p', p.toFixed(4));
      el.style.setProperty('--wobble', `${wobble.toFixed(2)}deg`);
      if (label.current) {
        const text = startedAt === undefined ? '' : (left / 1000).toFixed(left < 10000 ? 1 : 0);
        if (label.current.textContent !== text) label.current.textContent = text;
        label.current.classList.toggle('urgent', left > 0 && left < 5000);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [startedAt, deadline]);

  return (
    <div class={`puffer ${popped ? 'popped' : ''}`} ref={root} aria-hidden="true">
      <svg viewBox="-110 -110 220 220" class="puffer-svg">
        {popped ? (
          <g class="burst">
            {SPIKES.map((a) => (
              <line x1="0" y1="-30" x2="0" y2="-88" transform={`rotate(${a})`} />
            ))}
            <text y="12" text-anchor="middle">POP!</text>
          </g>
        ) : (
          <g class="fish">
            <g class="spikes">
              {SPIKES.map((a) => (
                <path d="M -7 -58 L 0 -86 L 7 -58 Z" transform={`rotate(${a})`} />
              ))}
            </g>
            <path class="tail" d="M 54 0 L 92 -24 L 84 0 L 92 24 Z" />
            <path class="fin" d="M -6 -60 Q 10 -84 26 -58 Z" />
            <circle class="body" r="62" />
            <ellipse class="belly" cx="-6" cy="22" rx="46" ry="30" />
            <g class="spots">
              <circle cx="18" cy="-34" r="6" />
              <circle cx="36" cy="-14" r="4.5" />
              <circle cx="4" cy="-46" r="3.5" />
            </g>
            <g class="eye">
              <circle cx="-26" cy="-14" r="15" fill="#fff" />
              <circle class="pupil" cx="-29" cy="-13" r="7" />
              <circle cx="-32" cy="-17" r="2.5" fill="#fff" />
            </g>
            <ellipse class="mouth" cx="-50" cy="14" rx="6" ry="8" />
            <path class="cheek" d="M -40 4 q 8 6 0 14" />
          </g>
        )}
      </svg>
      {timer && <div class="puffer-time" ref={label} />}
    </div>
  );
}
