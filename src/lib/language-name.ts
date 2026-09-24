/** ISO 639-2 codes found in Matroska files, mapped to the 2-letter codes Intl understands. */
const THREE_TO_TWO: Record<string, string> = {
  eng: "en", jpn: "ja", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", por: "pt",
  rus: "ru", chi: "zh", zho: "zh", kor: "ko", ara: "ar", hin: "hi", pol: "pl", tur: "tr", dut: "nl",
  nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", gre: "el", ell: "el", heb: "he", hun: "hu",
  cze: "cs", ces: "cs", rum: "ro", ron: "ro", tha: "th", vie: "vi", ind: "id", may: "ms", msa: "ms",
  ukr: "uk", per: "fa", fas: "fa", tam: "ta", tel: "te", ben: "bn", fil: "fil", tgl: "tl",
};

let displayNames: Intl.DisplayNames | null | undefined;

/** "eng" / "en" / "pt-BR" → "English" / "Portuguese (Brazil)"; unknown codes come back as given. */
export function languageName(code: string | null | undefined): string {
  const raw = (code ?? "").trim();
  if (!raw || raw === "und") return "Unknown";
  const [base = "", ...rest] = raw.toLowerCase().split("-");
  const normalized = [THREE_TO_TWO[base] ?? base, ...rest.map((part) => part.toUpperCase())].join("-");
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(normalized) ?? raw;
  } catch {
    return raw;
  }
}
