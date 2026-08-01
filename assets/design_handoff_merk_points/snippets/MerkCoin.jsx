import "./merk-tokens.css";
import "./merk-brand.css";

/**
 * MerkCoin — the struck "1 MERK" coin.
 * Authored at a 480px base and scaled, so relief stays proportional.
 * size: rendered diameter in px. Minimum 56. Legend detail drops out below
 * 300 (rim legend) and 150 ("ONE MERK" arc) — see merk-brand.css.
 */
export function MerkCoin({ size = 440, id = "merk", className = "", style }) {
  const band = size >= 300 ? "l" : size >= 150 ? "m" : "s";
  const rings = [0, 26, 52, 78, 104, 130, 156];
  const ringSet = (stroke, extra) => (
    <g fill="none" stroke={stroke} strokeWidth="2.3" {...extra}>
      {rings.map((r) => (
        <ellipse key={r} cx="54" cy="54" rx="35" ry="45" transform={`rotate(${r} 54 54)`} />
      ))}
    </g>
  );
  const glyphPaths = (stroke, extra) => (
    <g stroke={stroke} fill="none" strokeLinejoin="miter" strokeLinecap="butt" {...extra}>
      <path d="M 20 79 L 20 15 L 50 53 L 80 15 L 80 79" strokeWidth="10" />
      <path d="M 10 38 L 90 38" strokeWidth="6.4" />
      <path d="M 10 52 L 90 52" strokeWidth="6.4" />
    </g>
  );

  return (
    <div
      className={`merk-coin ${className}`}
      data-size-band={band}
      style={{ "--merk-coin-size": size, ...style }}
      role="img"
      aria-label="One merk"
    >
      <div className="merk-coin__stage">
        <div className="merk-coin__edge" />
        <div className="merk-coin__sheen" />
        <div className="merk-coin__rim" />
        <div className="merk-coin__field">
          <div className="merk-coin__guilloche-radial" />
          <div className="merk-coin__guilloche-rings" />
          <div className="merk-coin__field-light" />
        </div>

        <svg className="merk-coin__engraving" viewBox="0 0 480 480">
          <defs>
            <path id={`${id}-arc-bottom`} d="M 240 240 m -158 0 a 158 158 0 0 0 316 0" fill="none" />
            <path id={`${id}-arc-top`} d="M 240 240 m -202 0 a 202 202 0 0 1 404 0" fill="none" />
          </defs>
          <circle cx="240" cy="240" r="186" fill="none" stroke="rgba(255,246,214,.5)" strokeWidth="1.3" />
          <circle cx="240" cy="240" r="183.6" fill="none" stroke="rgba(60,40,4,.4)" strokeWidth="1.1" />
          <circle cx="240" cy="240" r="186" fill="none" stroke="rgba(43,30,6,.5)" strokeWidth="4.6" strokeDasharray="1.5 7.6" strokeLinecap="round" />
          <circle cx="240" cy="240" r="186.9" fill="none" stroke="rgba(255,246,214,.42)" strokeWidth="4.6" strokeDasharray="1.5 7.6" strokeLinecap="round" />
          <g data-legend>
            <g fill="rgba(255,243,206,.55)" style={{ fontFamily: "var(--merk-font-ui)", fontSize: 19, fontWeight: 500, letterSpacing: ".34em" }}>
              <text><textPath href={`#${id}-arc-bottom`} startOffset="50%" textAnchor="middle" dy="1.4">ONE MERK</textPath></text>
            </g>
            <g fill="#2B1E06" style={{ fontFamily: "var(--merk-font-ui)", fontSize: 19, fontWeight: 500, letterSpacing: ".34em" }}>
              <text><textPath href={`#${id}-arc-bottom`} startOffset="50%" textAnchor="middle">ONE MERK</textPath></text>
            </g>
          </g>
          <g data-rim>
            <g fill="rgba(255,243,206,.5)" style={{ fontFamily: "var(--merk-font-ui)", fontSize: 11, fontWeight: 500, letterSpacing: ".42em" }}>
              <text><textPath href={`#${id}-arc-top`} startOffset="50%" textAnchor="middle" dy="1.2">· SHOP LOCAL · EARN A MERK ·</textPath></text>
            </g>
            <g fill="rgba(43,30,6,.78)" style={{ fontFamily: "var(--merk-font-ui)", fontSize: 11, fontWeight: 500, letterSpacing: ".42em" }}>
              <text><textPath href={`#${id}-arc-top`} startOffset="50%" textAnchor="middle">· SHOP LOCAL · EARN A MERK ·</textPath></text>
            </g>
          </g>
        </svg>

        <div className="merk-coin__mintmark">
          <svg viewBox="0 0 108 108" style={{ width: "100%", height: "100%" }}>
            {ringSet("rgba(255,246,214,.62)", { transform: "translate(0,1.5)" })}
            {ringSet("#2B1E06", { strokeOpacity: ".9" })}
          </svg>
        </div>

        <div className="merk-coin__denomination">
          <svg viewBox="0 0 100 90" style={{ width: "100%", height: "100%" }}>
            {glyphPaths("rgba(255,246,214,.72)", { transform: "translate(0,1.8)" })}
            {glyphPaths("#2B1E06")}
          </svg>
        </div>
      </div>
    </div>
  );
}
