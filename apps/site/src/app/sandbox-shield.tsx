/* The home page's sandbox band, right side (#1264): one attempt's runs inside a shield. Left of it,
   left-aligned, the hosts a run may reach; right of it, right-aligned, the keys and hosts it may not.
   The shield and what is inside it are doc/milestone/0.15.0/home-shield/index.html's; the tags and
   their lines are not. Every host on the left is in BUILT_IN_DOMAINS and every path on the
   right is on the built-in deny list (packages/sandbox/src/policy.ts). The last tag on each side is a
   stack: more than is drawn. A line meets the shield at a mark 5 units outside its edge, drawn along
   the edge's tangent there — computed from the shield's path, so move a tag by moving the far end
   of its line and leave the mark alone. Classes and ids are prefixed because the site also loads
   the board's stylesheet, which owns `.chip`. */
export function SandboxShield() {
  return (
    <figure
      className="home-shield"
      aria-label="A shield around the agent's run; the hosts on the allowlist are reached from it, and the keys and config on the machine stay outside it"
    >
      <svg viewBox="0 0 560 490" aria-hidden="true">
        <defs>
          <linearGradient id="home-shield-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#215663" />
            <stop offset="1" stopColor="#122a31" />
          </linearGradient>
          <radialGradient id="home-shield-aura" cx="50%" cy="45%" r="55%">
            <stop className="home-shield-aura-stop" offset="0" stopOpacity=".34" />
            <stop className="home-shield-aura-stop" offset="1" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="280" cy="230" rx="210" ry="200" fill="url(#home-shield-aura)" />
        <path
          className="home-shield-field"
          d="M280 70 L392 112 V214 C392 296 344 360 280 392 C216 360 168 296 168 214 V112 Z"
          transform="translate(280 231) scale(1.13) translate(-280 -231)"
        />
        <path className="home-shield-ok" d="M200.6 94.4 Q176 82 167 58" />
        <circle className="home-shield-halo home-shield-open" cx="200.6" cy="94.4" r="7" />
        <line className="home-shield-cap home-shield-open" x1="195" y1="96.5" x2="206.2" y2="92.3" />
        <path className="home-shield-ok" d="M163 143.1 Q157 135 143 141" />
        <circle className="home-shield-halo home-shield-open" cx="163" cy="143.1" r="7" />
        <line className="home-shield-cap home-shield-open" x1="163" y1="149.1" x2="163" y2="137.1" />
        <path className="home-shield-ok" d="M163.3 226.1 Q142 238 113 228" />
        <circle className="home-shield-halo home-shield-open" cx="163.3" cy="226.1" r="7" />
        <line className="home-shield-cap home-shield-open" x1="163.7" y1="232.1" x2="163" y2="220.1" />
        <path className="home-shield-ok" d="M196 324.7 Q186 346 173 352" />
        <circle className="home-shield-halo home-shield-open" cx="196" cy="324.7" r="7" />
        <line className="home-shield-cap home-shield-open" x1="199.3" y1="329.7" x2="192.7" y2="319.7" />
        <path className="home-shield-ok" d="M252.7 381.8 Q232 424 128 448" />
        <circle className="home-shield-halo home-shield-open" cx="252.7" cy="381.8" r="7" />
        <line className="home-shield-cap home-shield-open" x1="257.7" y1="385.2" x2="247.7" y2="378.4" />
        <path className="home-shield-ray" d="M393 55 Q365.6 67.2 360.2 94.7" />
        <circle className="home-shield-halo" cx="360.2" cy="94.7" r="7" />
        <line className="home-shield-cap" x1="354.6" y1="92.6" x2="365.8" y2="96.8" />
        <path className="home-shield-ray" d="M458 141 Q430 130 397 140.9" />
        <circle className="home-shield-halo" cx="397" cy="140.9" r="7" />
        <line className="home-shield-cap" x1="397" y1="134.9" x2="397" y2="146.9" />
        <path className="home-shield-ray" d="M444 226 Q423 214 396.7 225.7" />
        <circle className="home-shield-halo" cx="396.7" cy="225.7" r="7" />
        <line className="home-shield-cap" x1="397" y1="219.7" x2="396.4" y2="231.6" />
        <path className="home-shield-ray" d="M429 297 Q406 284 382 290.9" />
        <circle className="home-shield-halo" cx="382" cy="290.9" r="7" />
        <line className="home-shield-cap" x1="384.3" y1="285.3" x2="379.7" y2="296.4" />
        <path className="home-shield-ray" d="M418 352 Q398 334 361.8 328" />
        <circle className="home-shield-halo" cx="361.8" cy="328" r="7" />
        <line className="home-shield-cap" x1="365.2" y1="323" x2="358.4" y2="332.9" />
        <path className="home-shield-ray" d="M402 448 Q362.7 409.9 307.7 381.5" />
        <circle className="home-shield-halo" cx="307.7" cy="381.5" r="7" />
        <line className="home-shield-cap" x1="312.6" y1="378.2" x2="302.7" y2="384.9" />
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
        <g className="home-shield-chip home-shield-allowed">
          <rect x="0" y="40" width="167" height="30" rx="8" />
          <g transform="translate(16 55)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-okv" d="M-3 0.2 L-0.8 2.4 L3.2 -2.2" />
          </g>
          <text className="home-shield-file" x="30" y="59.5">
            api.anthropic.com
          </text>
        </g>
        <g className="home-shield-chip home-shield-allowed">
          <rect x="0" y="126" width="143" height="30" rx="8" />
          <g transform="translate(16 141)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-okv" d="M-3 0.2 L-0.8 2.4 L3.2 -2.2" />
          </g>
          <text className="home-shield-file" x="30" y="145.5">
            api.openai.com
          </text>
        </g>
        <g className="home-shield-chip home-shield-allowed">
          <rect x="0" y="211" width="113" height="30" rx="8" />
          <g transform="translate(16 226)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-okv" d="M-3 0.2 L-0.8 2.4 L3.2 -2.2" />
          </g>
          <text className="home-shield-file" x="30" y="230.5">
            github.com
          </text>
        </g>
        <g className="home-shield-chip home-shield-allowed">
          <rect x="0" y="352" width="173" height="30" rx="8" />
          <g transform="translate(16 367)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-okv" d="M-3 0.2 L-0.8 2.4 L3.2 -2.2" />
          </g>
          <text className="home-shield-file" x="30" y="371.5">
            registry.npmjs.org
          </text>
        </g>
        <g className="home-shield-chip home-shield-allowed">
          <rect className="home-shield-under-2" x="10" y="456" width="146" height="30" rx="8" />
          <rect className="home-shield-under-1" x="5" y="452" width="146" height="30" rx="8" />
          <rect x="0" y="448" width="146" height="30" rx="8" />
          <text className="home-shield-file" x="73" y="467.5" textAnchor="middle">
            + your allowlist
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="393" y="40" width="167" height="30" rx="8" />
          <g transform="translate(409 55)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="423" y="59.5">
            ~/.ssh/id_ed25519
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="458" y="126" width="102" height="30" rx="8" />
          <g transform="translate(474 141)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="488" y="145.5">
            ~/.npmrc
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="444" y="211" width="116" height="30" rx="8" />
          <g transform="translate(460 226)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="474" y="230.5">
            ~/.lingtai
          </text>
        </g>
        <g className="home-shield-chip">
          <rect x="429" y="282" width="131" height="30" rx="8" />
          <g transform="translate(445 297)">
            <circle r="7" className="home-shield-lock" />
            <path className="home-shield-lockx" d="M-2.6 -2.6 L2.6 2.6 M2.6 -2.6 L-2.6 2.6" />
          </g>
          <text className="home-shield-file" x="459" y="301.5">
            pastebin.com
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
        <g className="home-shield-chip">
          <rect className="home-shield-under-2" x="374" y="456" width="176" height="30" rx="8" />
          <rect className="home-shield-under-1" x="379" y="452" width="176" height="30" rx="8" />
          <rect x="384" y="448" width="176" height="30" rx="8" />
          <text className="home-shield-file" x="472" y="467.5" textAnchor="middle">
            + blocked by default
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
