// Wrapper for opencc-js. Use generic Simplified/Traditional conversion for page-wide controls.
const s2t = globalThis.OpenCC.Converter({ from: "cn", to: "t" });
const t2s = globalThis.OpenCC.Converter({ from: "t", to: "cn" });

// Some pages use Hong Kong or Taiwan traditional variants. Run those first as
// fallbacks, then finish with generic Traditional -> Simplified conversion.
const hk2s = globalThis.OpenCC.Converter({ from: "hk", to: "cn" });
const tw2s = globalThis.OpenCC.Converter({ from: "tw", to: "cn" });

function toSimplified(text) {
  const value = String(text || "");
  // OpenCC's direct Traditional -> Simplified pass treats an isolated simplified
  // 么 as the traditional form of 幺. Preserve text that already round-trips as
  // canonical Simplified so repeated conversion stays idempotent (怎么, not 怎幺).
  const canonicalSimplified = t2s(s2t(value));
  if (canonicalSimplified === value) return value;
  const direct = t2s(value);
  if (direct !== value) return direct;
  const hongKong = hk2s(value);
  if (hongKong !== value) return hongKong;
  return tw2s(value);
}

globalThis.CombinedConverter = {
  toTraditional: (text) => s2t(String(text || "")),
  toSimplified
};