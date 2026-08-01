import "./merk-brand.css";

/**
 * MerkWordmark + lockups.
 * size = wordmark cap size in px; the strapline is 20% of it and the coin
 * in a lockup is ~2.4x the wordmark size.
 */
export function MerkWordmark({ size = 54, tone = "light", align = "left" }) {
  return (
    <div
      className={tone === "dark" ? "merk-lockup__text merk-on-dark" : "merk-lockup__text"}
      style={{ alignItems: align === "center" ? "center" : "flex-start", textAlign: align, fontSize: size }}
    >
      <div className="merk-wordmark" style={{ fontSize: size }}>Merk Points</div>
      <div className="merk-strapline">Shop local · Earn a merk</div>
    </div>
  );
}

export function MerkLockup({ size = 54, stacked = false, tone = "light" }) {
  // import MerkCoin from './MerkCoin'
  return (
    <div
      className={`merk-lockup ${stacked ? "merk-lockup--stacked" : ""} ${tone === "dark" ? "merk-on-dark" : ""}`}
      style={{ fontSize: size }}
    >
      {/* <MerkCoin size={Math.round(size * 2.4)} id={stacked ? "lockup-s" : "lockup-h"} /> */}
      <MerkWordmark size={size} tone={tone} align={stacked ? "center" : "left"} />
    </div>
  );
}
