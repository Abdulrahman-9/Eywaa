/** شعار المعونة: يدٌ تحمل قلباً نابضاً، والعطاء يسير منها إلى البيوت. يسكن لمن عطّل الحركة في جهازه. */
export function AidMotif({ className = '' }: { className?: string }) {
  return (
    <svg
      role="img"
      aria-label="يدٌ تعطي، والمعونة تسير منها إلى البيوت"
      viewBox="0 8 360 118"
      fill="none"
      stroke="var(--color-brand)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M110 62 Q 185 22 262 62" stroke="#9DBFB4" strokeDasharray="2 8" />
      <g transform="translate(238 20) scale(4.2)" strokeWidth="0.48">
        <path d="M11 14h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 16" />
        <path d="m7 20 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9" />
        <path d="m2 15 6 6" />
        <path
          className="aid-heart"
          fill="var(--color-warm)"
          stroke="var(--color-warm)"
          d="M19.5 8.5c.7-.7 1.5-1.6 1.5-2.7A2.73 2.73 0 0 0 16 4a2.78 2.78 0 0 0-5 1.8c0 1.2.8 2 1.5 2.8L16 12Z"
        />
      </g>
      <g fill="var(--color-brand)" stroke="none">
        {[0, 1.2, 2.4].map((delay) => (
          <rect key={delay} className="aid-parcel" style={{ animationDelay: `${delay}s` }} x="252" y="56" width="12" height="12" rx="3" />
        ))}
      </g>
      <g transform="translate(22 34) scale(3)" strokeWidth="0.67">
        <g className="aid-home"><path d="M4 21V10l8-6 8 6v11M9 21v-6h6v6" /></g>
      </g>
      <g transform="translate(84 61) scale(1.7)" strokeWidth="1.1" stroke="#6FA596">
        <path d="M4 21V10l8-6 8 6v11M9 21v-6h6v6" />
      </g>
      <path d="M20 97h112" stroke="#9DBFB4" />
    </svg>
  );
}
