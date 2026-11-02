import Link from "next/link";
import Logo from "./components/Logo";
import Reveal from "./components/Reveal";
import ThemeToggle from "./components/ThemeToggle";
import "./landing.css";

const REPO = "https://github.com/determined-001/Quay";

/** Light-line arrow used inside the nested button circles. */
function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M3.5 10.5L10.5 3.5M10.5 3.5H5M10.5 3.5V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A decorative QR-shaped block for the hero card. Deterministic so server and
 * client render the same markup; it encodes nothing and is hidden from
 * assistive tech.
 */
function QrArt() {
  const n = 21;
  const cells: string[] = [];
  const finder = (x: number, y: number) =>
    (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  let seed = 7919;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      seed = (seed * 48271) % 2147483647;
      if (finder(x, y)) continue;
      if (seed % 100 < 46) cells.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const eye = (x: number, y: number) =>
    `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`;
  return (
    <svg viewBox={`0 0 ${n} ${n}`} className="lp-qr" aria-hidden shapeRendering="crispEdges">
      <path d={cells.join("")} fill="#0b100f" />
      <path d={eye(0, 0) + eye(n - 7, 0) + eye(0, n - 7)} fill="#0b100f" fillRule="evenodd" />
    </svg>
  );
}

const STEPS = [
  {
    title: "Create a link",
    body: "Set an amount and a title. You get a hosted checkout page, a QR code and a snippet you can paste into your own site.",
  },
  {
    title: "The buyer pays from their wallet",
    body: "Any Stellar wallet works. The payment is matched by its memo and confirmed on-chain, so there is no card form and nothing to charge back.",
  },
  {
    title: "The USDC lands in your wallet",
    body: "Not in an account we run. Quay watches the network and tells you, and your webhooks, that the payment arrived.",
  },
  {
    title: "Cash out when you choose to",
    body: "Withdraw to local currency through a Stellar anchor. Your wallet signs the login and the withdrawal, so we never hold your key or your funds.",
  },
];

const STATUS: { name: string; note: string; state: "live" | "testing" | "planned" }[] = [
  {
    name: "Payment links, checkout, widget",
    note: "Running on Stellar mainnet since 6 September 2026.",
    state: "live",
  },
  {
    name: "Webhooks, API keys, receipts, CSV export",
    note: "Included with every deployment.",
    state: "live",
  },
  {
    name: "Cash-out to local currency",
    note: "Built and tested against the Stellar test anchor. Not enabled on mainnet until a production anchor is signed.",
    state: "testing",
  },
  {
    name: "Best-rate routing across anchors",
    note: "Planned. It will pick the anchor with the better rate at the moment you withdraw.",
    state: "planned",
  },
];

export default function LandingPage() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-nav__pill">
          <Logo size={26} />
          <nav className="lp-nav__links" aria-label="Primary">
            <a href="#how">How it works</a>
            <a href="#build">Build</a>
            <a href="#status">Status</a>
            <a href={REPO}>Source</a>
          </nav>
          <ThemeToggle />
          <Link href="/dashboard" className="lp-btn lp-btn--solid lp-btn--sm">
            Open dashboard
            <span className="lp-btn__icon">
              <Arrow />
            </span>
          </Link>
        </div>
      </header>

      <main>
        {/* ---------- hero: editorial split ---------- */}
        <section className="lp-hero">
          <div className="lp-hero__copy">
            <p className="lp-eyebrow">Non-custodial checkout · USDC on Stellar</p>
            <h1 className="lp-h1">
              Get paid in dollars. <span>Keep your keys.</span>
            </h1>
            <p className="lp-lede">
              Payment links, a hosted checkout and a widget for your own site. Buyers pay from their wallet straight
              to yours, and when you want local currency you cash out through a Stellar anchor.
            </p>
            <div className="lp-cta">
              <Link href="/dashboard" className="lp-btn lp-btn--solid">
                Create a payment link
                <span className="lp-btn__icon">
                  <Arrow />
                </span>
              </Link>
              <Link href="/demo" className="lp-textlink">
                See the checkout in a demo store
              </Link>
            </div>
            <ul className="lp-proof">
              <li>Funds never touch Quay</li>
              <li>Apache-2.0 licensed</li>
              <li>Live on Stellar mainnet</li>
            </ul>
          </div>

          <div className="lp-hero__visual" aria-hidden>
            <div className="lp-bezel lp-float">
              <div className="lp-checkout">
                <div className="lp-checkout__top">
                  <span>Ceramic Artisans Co.</span>
                  <span className="lp-checkout__net">Stellar</span>
                </div>
                <p className="lp-checkout__title">Handcrafted ceramic mug</p>
                <p className="lp-checkout__amount">
                  25.00<span>USDC</span>
                </p>
                <div className="lp-checkout__qr">
                  <QrArt />
                </div>
                <div className="lp-checkout__pay">Open in wallet</div>
                <p className="lp-checkout__wait">
                  <i /> Waiting for payment · 9:41
                </p>
              </div>
            </div>
            <div className="lp-receipt lp-float lp-float--late">
              <span className="lp-receipt__dot" />
              <div>
                <strong>Payment received</strong>
                <span>25.00 USDC · matched by memo</span>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- how it works ---------- */}
        <section id="how" className="lp-section lp-how">
          <Reveal className="lp-how__head">
            <p className="lp-eyebrow">How it works</p>
            <h2 className="lp-h2">From link to local currency, without a middleman holding the money.</h2>
          </Reveal>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <Reveal delay={i * 70}>
                  <span className="lp-steps__n">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </Reveal>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------- bento ---------- */}
        <section id="build" className="lp-section">
          <Reveal>
            <p className="lp-eyebrow">What you get</p>
            <h2 className="lp-h2 lp-h2--wide">Everything a store needs to take a payment, nothing that holds your balance.</h2>
          </Reveal>

          <div className="lp-bento">
            <Reveal className="lp-cell lp-cell--keys">
              <div className="lp-bezel">
                <div className="lp-card">
                  <h3>Your keys, your funds</h3>
                  <p>
                    Quay&apos;s servers never hold a key that can move your money. Your wallet signs your login and
                    your withdrawal. If Quay went offline tomorrow, your balance would be exactly where it is now.
                  </p>
                  <svg className="lp-flow" viewBox="0 0 460 110" fill="none" role="img" aria-label="The buyer's wallet pays your wallet directly. Quay only watches the network.">
                    <rect x="1" y="30" width="118" height="50" rx="14" className="lp-flow__node" />
                    <text x="60" y="60" textAnchor="middle" className="lp-flow__text">Buyer wallet</text>
                    <rect x="341" y="30" width="118" height="50" rx="14" className="lp-flow__node lp-flow__node--on" />
                    <text x="400" y="60" textAnchor="middle" className="lp-flow__text">Your wallet</text>
                    <path d="M121 55H339" className="lp-flow__line" />
                    <path d="M331 49l8 6-8 6" className="lp-flow__line" />
                    <path d="M230 55V98" className="lp-flow__dash" />
                    <text x="230" y="108" textAnchor="middle" className="lp-flow__note">Quay watches, cannot spend</text>
                  </svg>
                </div>
              </div>
            </Reveal>

            <Reveal className="lp-cell lp-cell--widget" delay={80}>
              <div className="lp-bezel">
                <div className="lp-card">
                  <h3>A widget for any site</h3>
                  <p>One script tag and a button. The checkout opens in a frame on your page.</p>
                  <pre className="lp-code">
                    <code>
                      <span className="c">{"<!-- paste before </body> -->"}</span>
                      {"\n"}
                      <span className="t">{"<script"}</span> <span className="a">src</span>=<span className="s">&quot;https://quay-web.vercel.app/widget.js&quot;</span> <span className="a">defer</span>
                      <span className="t">{"></script>"}</span>
                      {"\n\n"}
                      <span className="t">{"<button"}</span> <span className="a">data-quay-link</span>=<span className="s">&quot;lnk_…&quot;</span>
                      <span className="t">{">"}</span>
                      {"Pay"}
                      <span className="t">{"</button>"}</span>
                    </code>
                  </pre>
                </div>
              </div>
            </Reveal>

            <Reveal className="lp-cell lp-cell--a" delay={60}>
              <div className="lp-bezel">
                <div className="lp-card">
                  <h3>Webhooks and API keys</h3>
                  <p>A signed webhook for each payment, and scoped keys for your server.</p>
                </div>
              </div>
            </Reveal>

            <Reveal className="lp-cell lp-cell--b" delay={120}>
              <div className="lp-bezel">
                <div className="lp-card">
                  <h3>Receipts and exports</h3>
                  <p>A receipt page for every payment, and a CSV for your books.</p>
                </div>
              </div>
            </Reveal>

            <Reveal className="lp-cell lp-cell--c" delay={180}>
              <div className="lp-bezel">
                <div className="lp-card">
                  <h3>Open source</h3>
                  <p>
                    Read it, run it yourself, or send a fix. <a href={REPO}>Source on GitHub</a>.
                  </p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------- status, stated plainly ---------- */}
        <section id="status" className="lp-section lp-status">
          <Reveal className="lp-status__head">
            <p className="lp-eyebrow">Where Quay is today</p>
            <h2 className="lp-h2">What works now, and what does not yet.</h2>
            <p className="lp-lede lp-lede--tight">
              Cash-out is the part people ask about first. It is not switched on for real money yet, and this page
              will say so until it is.
            </p>
          </Reveal>
          <ul className="lp-statuslist">
            {STATUS.map((s, i) => (
              <li key={s.name}>
                <Reveal delay={i * 60}>
                  <span className={`lp-tag lp-tag--${s.state}`}>
                    {s.state === "live" ? "Live" : s.state === "testing" ? "Testing" : "Planned"}
                  </span>
                  <div>
                    <strong>{s.name}</strong>
                    <p>{s.note}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------- closing ---------- */}
        <section className="lp-section lp-close">
          <Reveal>
            <h2 className="lp-h2 lp-h2--wide">Make your first payment link.</h2>
            <div className="lp-cta lp-cta--center">
              <Link href="/dashboard" className="lp-btn lp-btn--solid">
                Open dashboard
                <span className="lp-btn__icon">
                  <Arrow />
                </span>
              </Link>
              <a href={REPO} className="lp-textlink">
                Read the source
              </a>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="lp-footer">
        <Logo size={22} />
        <nav aria-label="Footer">
          <Link href="/privacy">Privacy</Link>
          <Link href="/demo">Demo store</Link>
          <a href={REPO}>GitHub</a>
        </nav>
        <p>© 2026 Quay. Apache-2.0.</p>
      </footer>
    </div>
  );
}
