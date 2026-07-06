// The system architecture diagram as INLINE SVG, so every label is real,
// selectable DOM text (slide-system-rules.md §§0.4, 8) — not baked into an image.
// Slide *content* still lives in slide data; this is a labelled figure rendered
// as an island, and its <text> nodes are part of the page DOM.

const LIGHT = "#e8edf5";
const SUB = "#9fb0cc";
const BOX = "#18223a";
const VIOLET = "#a78bfa";
const AMBER = "#f0a44a";
const TEAL = "#4fd1c5";
const GREY = "#9fb0cc";

export function ArchitectureDiagram() {
  return (
    <svg
      viewBox="0 0 1000 540"
      role="img"
      aria-label="System architecture"
      style={{ width: "100%", height: "100%" }}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
    >
      <defs>
        <marker
          id="arch-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={GREY} />
        </marker>
        <marker
          id="arch-arrow2"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill={TEAL} />
        </marker>
      </defs>

      {/* Row 1: author -> vercel */}
      <rect x="60" y="32" width="220" height="74" rx="14" fill={BOX} stroke={VIOLET} strokeWidth="2" />
      <text x="170" y="64" textAnchor="middle" fill={LIGHT} fontSize="22" fontWeight="600">
        You (author)
      </text>
      <text x="170" y="90" textAnchor="middle" fill={SUB} fontSize="17">
        Cursor / Claude
      </text>

      <line x1="280" y1="69" x2="430" y2="69" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />
      <text x="355" y="58" textAnchor="middle" fill={SUB} fontSize="15">
        deploy
      </text>

      <rect x="430" y="32" width="260" height="74" rx="14" fill={BOX} stroke={AMBER} strokeWidth="2" />
      <text x="560" y="64" textAnchor="middle" fill={LIGHT} fontSize="22" fontWeight="600">
        Slide app on Vercel
      </text>
      <text x="560" y="90" textAnchor="middle" fill={SUB} fontSize="17">
        a library of decks
      </text>

      {/* app -> three views */}
      <path d="M520 106 L150 168" fill="none" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />
      <path d="M560 106 L500 168" fill="none" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />
      <path d="M620 106 L825 168" fill="none" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />

      {/* Row 2: three views */}
      <rect x="30" y="172" width="240" height="86" rx="14" fill={BOX} stroke={TEAL} strokeWidth="2" />
      <text x="150" y="206" textAnchor="middle" fill={LIGHT} fontSize="22" fontWeight="600">
        Main view
      </text>
      <text x="150" y="232" textAnchor="middle" fill={SUB} fontSize="17">
        projector · fullscreen
      </text>

      <rect x="380" y="172" width="240" height="86" rx="14" fill={BOX} stroke={TEAL} strokeWidth="2" />
      <text x="500" y="206" textAnchor="middle" fill={LIGHT} fontSize="22" fontWeight="600">
        Presenter view
      </text>
      <text x="500" y="232" textAnchor="middle" fill={SUB} fontSize="17">
        next · notes · timer
      </text>

      <rect x="705" y="172" width="240" height="86" rx="14" fill={BOX} stroke={VIOLET} strokeWidth="2" />
      <text x="825" y="206" textAnchor="middle" fill={LIGHT} fontSize="22" fontWeight="600">
        AI sidebar
      </text>
      <text x="825" y="232" textAnchor="middle" fill={SUB} fontSize="17">
        ask the slides
      </text>

      {/* sync between main and presenter */}
      <line
        x1="270"
        y1="215"
        x2="380"
        y2="215"
        stroke={TEAL}
        strokeWidth="2.5"
        markerEnd="url(#arch-arrow2)"
        markerStart="url(#arch-arrow2)"
      />
      <text x="325" y="290" textAnchor="middle" fill={TEAL} fontSize="15">
        BroadcastChannel
      </text>
      <text x="325" y="310" textAnchor="middle" fill={SUB} fontSize="15">
        same browser · no server
      </text>

      {/* sidebar -> serverless */}
      <line x1="825" y1="258" x2="825" y2="330" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />

      <rect x="690" y="334" width="270" height="80" rx="14" fill={BOX} stroke={AMBER} strokeWidth="2" />
      <text x="825" y="368" textAnchor="middle" fill={LIGHT} fontSize="22" fontWeight="600">
        Serverless function
      </text>
      <text x="825" y="394" textAnchor="middle" fill={SUB} fontSize="17">
        holds the key, server-side
      </text>

      {/* serverless -> openrouter + kv */}
      <path d="M760 414 L660 470" fill="none" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />
      <path d="M890 414 L890 470" fill="none" stroke={GREY} strokeWidth="2" markerEnd="url(#arch-arrow)" />

      <rect x="470" y="474" width="210" height="58" rx="12" fill={BOX} stroke={GREY} strokeWidth="2" />
      <text x="575" y="510" textAnchor="middle" fill={LIGHT} fontSize="20" fontWeight="600">
        OpenRouter
      </text>

      <rect x="785" y="474" width="210" height="58" rx="12" fill={BOX} stroke={GREY} strokeWidth="2" />
      <text x="890" y="503" textAnchor="middle" fill={LIGHT} fontSize="20" fontWeight="600">
        KV store
      </text>
      <text x="890" y="523" textAnchor="middle" fill={SUB} fontSize="14">
        token counts only
      </text>

      {/* privacy note */}
      <text x="240" y="468" fill={SUB} fontSize="16">
        No prompt or answer is ever stored —
      </text>
      <text x="240" y="490" fill={SUB} fontSize="16">
        only {"{ name, timestamp, token_count }"}.
      </text>
    </svg>
  );
}
