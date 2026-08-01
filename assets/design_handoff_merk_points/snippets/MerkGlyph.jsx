import "./merk-brand.css";

/** The merk currency symbol. Sizes with font-size, inherits currentColor. */
export function MerkGlyph({ className = "", ...rest }) {
  return (
    <svg className={`merk-glyph ${className}`} viewBox="0 0 100 90" role="img" aria-label="merk" {...rest}>
      <g fill="none" stroke="currentColor" strokeLinejoin="miter" strokeLinecap="butt">
        <path d="M 20 79 L 20 15 L 50 53 L 80 15 L 80 79" strokeWidth="10" />
        <path d="M 10 38 L 90 38" strokeWidth="6.4" />
        <path d="M 10 52 L 90 52" strokeWidth="6.4" />
      </g>
    </svg>
  );
}

/** Merk amounts are whole numbers, thousands-separated: 1,250 */
export function formatMerks(n) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(n);
}

/** Price display: <MerkPrice merks={250} /> → ᛗ250 with a gold glyph. */
export function MerkPrice({ merks, className = "" }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: ".18em" }}>
      <MerkGlyph style={{ color: "var(--merk-gold)" }} />
      {formatMerks(merks)}
    </span>
  );
}
