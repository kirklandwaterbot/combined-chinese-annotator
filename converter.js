// Wrapper for opencc-js. Use generic Simplified/Traditional conversion for page-wide controls.
const s2t = globalThis.OpenCC.Converter({ from: "cn", to: "t" });
const t2s = globalThis.OpenCC.Converter({ from: "t", to: "cn" });

// Some pages use Hong Kong or Taiwan traditional variants. Run those first as
// fallbacks, then finish with generic Traditional -> Simplified conversion.
const hk2s = globalThis.OpenCC.Converter({ from: "hk", to: "cn" });
const tw2s = globalThis.OpenCC.Converter({ from: "tw", to: "cn" });

function toSimplified(text) {
  const value = String(text || "");
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