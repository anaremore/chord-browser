/**
 * A single-page app an agent acts in (agents-spa.spec.ts; Neon's factory audit, item 5): what real sites do that small
 * static pages don't, in React 19, bundled by the test (rolldown) and served from one address for every route.
 *
 * - **Controlled fields**: React owns the value; one takes digits only and throws the rest away.
 * - **Nodes the page replaces**: a list re-keyed on a timer (the same buttons, new elements, every 300 ms), and a
 *   button that's put back as a new element when the pointer comes over it.
 * - **A portal**: the menu renders into document.body, outside the app's tree.
 * - **Overlays**: a sticky header, and a dialog that arrives a moment after a click, over the button the agent
 *   took a ref to before it came.
 * - **Client-side routes**: links that go by pushState, with the app drawing the new route.
 * - **Shadow DOM**: a custom element whose button lives in an open shadow root.
 *
 * Every action writes a line to the log (`role=log`, "Activity"), so the test reads what the page actually got.
 * Buttons avoid the words Chord asks about first (core's RISK_WORDS: buy, order, …): risky steps have their own E2E.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

function useLog(): [string[], (line: string) => void] {
  const [lines, setLines] = useState<string[]>([]);
  return [lines, (line) => setLines((l) => [...l, line])];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} style={{ margin: '24px 0' }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Profile({ log }: { log: (line: string) => void }) {
  const [name, setName] = useState('');
  const [zip, setZip] = useState('');
  return (
    <Section title="Profile">
      <label>
        Name <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p>Hello, {name || 'you'}</p>
      <label>
        Zip code <input inputMode="numeric" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))} />
      </label>
      <button onClick={() => log(`saved ${name}, ${zip || 'no zip'}`)}>Save profile</button>
    </Section>
  );
}

function LivePrices({ log }: { log: (line: string) => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 300);
    return () => clearInterval(timer);
  }, []);
  // A new key each tick: React throws the old buttons away and makes new ones, with the same role, name and place.
  return (
    <Section title="Live prices">
      <ul>
        {['apples', 'pears'].map((fruit) => (
          <li key={`${fruit}-${tick}`}>
            <button onClick={() => log(`picked ${fruit}`)}>Pick {fruit}</button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function HoverCard({ log }: { log: (line: string) => void }) {
  const [hovered, setHovered] = useState(false);
  // The pointer arriving puts a new element in the button's place (its key changes), as hover cards often do.
  return (
    <Section title="Hover card">
      <button key={hovered ? 'hovered' : 'resting'} onMouseEnter={() => setHovered(true)} onClick={() => log('opened details')} style={{ inlineSize: 160, blockSize: 40 }}>
        Details
      </button>
    </Section>
  );
}

function Menu({ log }: { log: (line: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Menu">
      <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        More actions
      </button>
      {open &&
        createPortal(
          <div role="menu" aria-label="More actions" style={{ position: 'fixed', insetBlockStart: 80, insetInlineEnd: 24, background: 'white', border: '1px solid gray', padding: 8 }}>
            {['Rename', 'Duplicate'].map((item) => (
              <div
                key={item}
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  log(`menu ${item.toLowerCase()}`);
                  setOpen(false);
                }}
              >
                {item}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </Section>
  );
}

/** Offers: the newsletter dialog arrives a moment after Show offers, over the middle of the window. */
function Offers({ log }: { log: (line: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <Section title="Offers">
      <button onClick={() => setTimeout(() => setShown(true), 800)}>Show offers</button>
      <button onClick={() => log('reminded later')} style={{ marginInlineStart: 16 }}>
        Remind me later
      </button>
      {shown && (
        <div role="dialog" aria-label="Newsletter" style={{ position: 'fixed', insetInline: 0, insetBlockEnd: 0, blockSize: '70vh', background: 'white', borderBlockStart: '1px solid gray', zIndex: 2 }}>
          <p>Get our newsletter</p>
          <button onClick={() => setShown(false)}>No thanks</button>
        </div>
      )}
    </Section>
  );
}

/** A custom element with its button in an open shadow root. */
class Stepper extends HTMLElement {
  connectedCallback(): void {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = 'Add one';
    button.addEventListener('click', () => this.dispatchEvent(new CustomEvent('step', { bubbles: true, composed: true })));
    root.append(button);
  }
}
customElements.define('chord-stepper', Stepper);

function Steps({ log }: { log: (line: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    const onStep = () => log('stepped');
    el?.addEventListener('step', onStep);
    return () => el?.removeEventListener('step', onStep);
  });
  return (
    <Section title="Steps">
      <chord-stepper ref={ref} />
    </Section>
  );
}

declare module 'react' {
  // oxlint-disable-next-line typescript/no-namespace -- JSX's own intrinsic elements are declared in its namespace
  namespace JSX {
    interface IntrinsicElements {
      'chord-stepper': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

const ROUTES: Record<string, string> = { '/spa': 'Home', '/spa/orders': 'Orders' };

function App() {
  const [path, setPath] = useState(location.pathname);
  const [lines, log] = useLog();
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    document.title = `Shop · ${ROUTES[path] ?? 'Not found'}`;
  }, [path]);
  const go = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    history.pushState(null, '', to);
    setPath(to);
    log(`went to ${to}`);
  };
  return (
    <>
      <header role="banner" style={{ position: 'sticky', insetBlockStart: 0, blockSize: 64, background: 'white', borderBlockEnd: '1px solid gray', zIndex: 1 }}>
        <nav aria-label="Shop">
          <a href="/spa" onClick={go('/spa')}>
            Home
          </a>{' '}
          <a href="/spa/orders" onClick={go('/spa/orders')}>
            Orders
          </a>
        </nav>
      </header>
      <main>
        <h1>{ROUTES[path] ?? 'Not found'}</h1>
        {path === '/spa/orders' ? (
          <Section title="Your orders">
            <button onClick={() => log('opened parcel 7')}>Show parcel 7</button>
          </Section>
        ) : (
          <>
            <Profile log={log} />
            <LivePrices log={log} />
            <HoverCard log={log} />
            <Menu log={log} />
            <Steps log={log} />
            <Offers log={log} />
            <div style={{ blockSize: '150vh' }} />
            <Section title="Checkout">
              <button onClick={() => log('saw reviews')}>See all reviews</button>
            </Section>
          </>
        )}
        <div role="log" aria-label="Activity">
          {lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
