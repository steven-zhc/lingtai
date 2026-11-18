/* The home page's sandbox band, right side (#1264): one attempt's runs inside a shield, the keys and
   hosts it cannot reach outside it. Copied from doc/milestone/0.15.0/home-shield/index.html — every
   number is the mock's, so do not recompute them. Every path drawn is on the built-in deny list
   (packages/sandbox/src/policy.ts). Classes and ids are prefixed because the site also loads the
   board's stylesheet, which owns `.chip`. */
export function SandboxShield() {
  return (
    <figure
      className="home-shield"
      aria-label="A shield around the agent's run; the keys and config on the machine stay outside it"
    >
      <svg viewBox="0 0 560 490" aria-hidden="true">
        <defs>
          <linearGradient id="home-shield-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#173540" />
            <stop offset="1" stopColor="#0e191d" />
          </linearGradient>
          <radialGradient id="home-shield-aura" cx="50%" cy="45%" r="55%">
            <stop className="home-shield-aura-stop" offset="0" stopOpacity=".16" />
            <stop className="home-shield-aura-stop" offset="1" stopOpacity="0" />
          </radialGradient>
          <marker
            id="home-shield-arrow"
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path className="home-shield-arrowhead" d="M0 0 L8 4 L0 8 Z" />
          </marker>
        </defs>
        <ellipse cx="280" cy="230" rx="210" ry="200" fill="url(#home-shield-aura)" />
        <path
          className="home-shield-field"
          d="M280 70 L392 112 V214 C392 296 344 360 280 392 C216 360 168 296 168 214 V112 Z"
          transform="translate(280 231) scale(1.13) translate(-280 -231)"
        />
        <path className="home-shield-ray" d="M167.0 55.0 Q174.6 79.6 197.6 91.3" />
        <circle className="home-shield-halo" cx="197.6" cy="91.3" r="7" />
        <line className="home-shield-cap" x1="193.0" y1="95.2" x2="202.2" y2="87.5" />
        <path className="home-shield-ray" d="M386.0 55.0 Q365.6 67.2 361.6 90.7" />
        <circle className="home-shield-halo" cx="361.6" cy="90.7" r="7" />
        <line className="home-shield-cap" x1="356.7" y1="87.4" x2="366.6" y2="94.1" />
        <path className="home-shield-ray" d="M120.0 226.0 Q139.0 236.0 158.0 226.0" />
        <circle className="home-shield-halo" cx="158.0" cy="226.0" r="7" />
        <line className="home-shield-cap" x1="158.0" y1="232.0" x2="158.0" y2="220.0" />
        <path className="home-shield-ray" d="M426.0 226.0 Q414.0 216.0 402.0 226.0" />
        <circle className="home-shield-halo" cx="402.0" cy="226.0" r="7" />
        <line className="home-shield-cap" x1="402.0" y1="220.0" x2="402.0" y2="232.0" />
        <path className="home-shield-ray" d="M164.0 352.0 Q184.6 347.9 192.3 328.4" />
        <circle className="home-shield-halo" cx="192.3" cy="328.4" r="7" />
        <line className="home-shield-cap" x1="196.2" y1="333.0" x2="188.5" y2="323.8" />
        <path className="home-shield-ray" d="M418.0 352.0 Q398.0 330.4 368.9 326.6" />
        <circle className="home-shield-halo" cx="368.9" cy="326.6" r="7" />
        <line className="home-shield-cap" x1="371.6" y1="321.3" x2="366.1" y2="331.9" />
        <path
          className="home-shield-glow"
          d="M280 70 L392 112 V214 C392 296 344 360 280 392 C216 360 168 296 168 214 V112 Z"
        />
        <path
          className="home-shield-shield"
          d="M280 70 L392 112 V214 C392 296 344 360 280 392 C216 360 168 296 168 214 V112 Z"
        />
        <path
          className="home-shield-inner"
          d="M280 70 L392 112 V214 C392 296 344 360 280 392 C216 360 168 296 168 214 V112 Z"
          transform="translate(280 231) scale(.93) translate(-280 -231)"
        />
        <text className="home-shield-title" x="280" y="146" textAnchor="middle">
          #42 &middot; ATTEMPT 1
        </text>
        <circle className="home-shield-dot home-shield-d1" cx="198" cy="180" r="3.5" />
        <text className="home-shield-run" x="209" y="184">
          Claude Code
        </text>
        <text className="home-shield-role" x="364" y="184" textAnchor="end">
          writes
        </text>
        <circle className="home-shield-dot home-shield-d2" cx="198" cy="212" r="3.5" />
        <text className="home-shield-run" x="209" y="216">
          pnpm test
        </text>
        <text className="home-shield-role" x="364" y="216" textAnchor="end">
          checks
        </text>
        <circle className="home-shield-dot home-shield-d3" cx="198" cy="244" r="3.5" />
        <text className="home-shield-run" x="209" y="248">
          Codex
        </text>
        <text className="home-shield-role" x="364" y="248" textAnchor="end">
          reviews
        </text>
        <line className="home-shield-sep" x1="214" y1="268" x2="346" y2="268" />
        <text className="home-shield-title" x="280" y="292" textAnchor="middle">
          IN ITS WORKTREE
        </text>
        <g className="home-shield-chip">
          <rect x="0" y="40" width="167" height="30" rx="8" />
          <g transform="translate(16 55)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="30" y="59.5">
            ~/.ssh/id_ed25519
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="386" y="40" width="174" height="30" rx="8" />
          <g transform="translate(402 55)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="416" y="59.5">
            ~/.aws/credentials
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="18" y="211" width="102" height="30" rx="8" />
          <g transform="translate(34 226)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="48" y="230.5">
            ~/.npmrc
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="426" y="211" width="116" height="30" rx="8" />
          <g transform="translate(442 226)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="456" y="230.5">
            ~/.lingtai
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="0" y="352" width="204" height="30" rx="8" />
          <g transform="translate(16 367)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="30" y="371.5">
            ~/.config/gh/hosts.yml
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="378" y="352" width="182" height="30" rx="8" />
          <g transform="translate(394 367)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="408" y="371.5">
            ~/Library/Keychains
          </text>
        </g>
        <path className="home-shield-ok" d="M262 372 Q252 408 224 440" markerEnd="url(#home-shield-arrow)" />
        <g className="home-shield-chip home-shield-allowed">
          <rect x="86" y="448" width="167" height="30" rx="8" />
          <g transform="translate(102 463)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-okv" d="M-3 0.2 L-0.8 2.4 L3.2 -2.2" />
          </g>
          <text className="home-shield-file" x="116" y="467.5">
            api.anthropic.com
          </text>
        </g>
        <path className="home-shield-ray" d="M402.0 448.0 Q362.7 409.9 312.3 388.5" />
        <circle className="home-shield-halo" cx="312.3" cy="388.5" r="7" />
        <line className="home-shield-cap" x1="315.6" y1="383.5" x2="309.0" y2="393.5" />
        <g className="home-shield-chip">
          <rect x="372" y="448" width="131" height="30" rx="8" />
          <g transform="translate(388 463)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="402" y="467.5">
            pastebin.com
          </text>
        </g>
      </svg>
      <div className="home-shield-legend" aria-hidden="true">
        <span>
          <b className="home-shield-r">✕</b>stopped by the sandbox
        </span>
        <span>
          <b className="home-shield-g">✓</b>on the allowlist
        </span>
        <span className="home-shield-t">ILLUSTRATION</span>
      </div>
    </figure>
  )
}
