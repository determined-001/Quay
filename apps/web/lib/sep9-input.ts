import { ISO3166_ALPHA3_CODES, sep9Field, validateSep9Value, type Sep9Field } from "@checkout/core";

/** ISO 3166-1 alpha-3 -> alpha-2, used only to get a display name from Intl. */
const A3_TO_A2 =
  "ABW:AW AFG:AF AGO:AO AIA:AI ALA:AX ALB:AL AND:AD ARE:AE ARG:AR ARM:AM ASM:AS ATA:AQ ATF:TF ATG:AG AUS:AU AUT:AT " +
  "AZE:AZ BDI:BI BEL:BE BEN:BJ BES:BQ BFA:BF BGD:BD BGR:BG BHR:BH BHS:BS BIH:BA BLM:BL BLR:BY BLZ:BZ BMU:BM BOL:BO " +
  "BRA:BR BRB:BB BRN:BN BTN:BT BVT:BV BWA:BW CAF:CF CAN:CA CCK:CC CHE:CH CHL:CL CHN:CN CIV:CI CMR:CM COD:CD COG:CG " +
  "COK:CK COL:CO COM:KM CPV:CV CRI:CR CUB:CU CUW:CW CXR:CX CYM:KY CYP:CY CZE:CZ DEU:DE DJI:DJ DMA:DM DNK:DK DOM:DO " +
  "DZA:DZ ECU:EC EGY:EG ERI:ER ESH:EH ESP:ES EST:EE ETH:ET FIN:FI FJI:FJ FLK:FK FRA:FR FRO:FO FSM:FM GAB:GA GBR:GB " +
  "GEO:GE GGY:GG GHA:GH GIB:GI GIN:GN GLP:GP GMB:GM GNB:GW GNQ:GQ GRC:GR GRD:GD GRL:GL GTM:GT GUF:GF GUM:GU GUY:GY " +
  "HKG:HK HMD:HM HND:HN HRV:HR HTI:HT HUN:HU IDN:ID IMN:IM IND:IN IOT:IO IRL:IE IRN:IR IRQ:IQ ISL:IS ISR:IL ITA:IT " +
  "JAM:JM JEY:JE JOR:JO JPN:JP KAZ:KZ KEN:KE KGZ:KG KHM:KH KIR:KI KNA:KN KOR:KR KWT:KW LAO:LA LBN:LB LBR:LR LBY:LY " +
  "LCA:LC LIE:LI LKA:LK LSO:LS LTU:LT LUX:LU LVA:LV MAC:MO MAF:MF MAR:MA MCO:MC MDA:MD MDG:MG MDV:MV MEX:MX MHL:MH " +
  "MKD:MK MLI:ML MLT:MT MMR:MM MNE:ME MNG:MN MNP:MP MOZ:MZ MRT:MR MSR:MS MTQ:MQ MUS:MU MWI:MW MYS:MY MYT:YT NAM:NA " +
  "NCL:NC NER:NE NFK:NF NGA:NG NIC:NI NIU:NU NLD:NL NOR:NO NPL:NP NRU:NR NZL:NZ OMN:OM PAK:PK PAN:PA PCN:PN PER:PE " +
  "PHL:PH PLW:PW PNG:PG POL:PL PRI:PR PRK:KP PRT:PT PRY:PY PSE:PS PYF:PF QAT:QA REU:RE ROU:RO RUS:RU RWA:RW SAU:SA " +
  "SDN:SD SEN:SN SGP:SG SGS:GS SHN:SH SJM:SJ SLB:SB SLE:SL SLV:SV SMR:SM SOM:SO SPM:PM SRB:RS SSD:SS STP:ST SUR:SR " +
  "SVK:SK SVN:SI SWE:SE SWZ:SZ SXM:SX SYC:SC SYR:SY TCA:TC TCD:TD TGO:TG THA:TH TJK:TJ TKL:TK TKM:TM TLS:TL TON:TO " +
  "TTO:TT TUN:TN TUR:TR TUV:TV TWN:TW TZA:TZ UGA:UG UKR:UA UMI:UM URY:UY USA:US UZB:UZ VAT:VA VCT:VC VEN:VE VGB:VG " +
  "VIR:VI VNM:VN VUT:VU WLF:WF WSM:WS YEM:YE ZAF:ZA ZMB:ZM ZWE:ZW";

const A2_BY_A3 = new Map(A3_TO_A2.split(" ").map((p) => p.split(":") as [string, string]));

export interface CountryOption {
  code: string;
  label: string;
}

/** Country options as "Nigeria (NGA)", sorted by name. Falls back to the bare code. */
export function countryOptions(locale = "en"): CountryOption[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = null;
  }
  const out: CountryOption[] = [];
  for (const code of ISO3166_ALPHA3_CODES) {
    const a2 = A2_BY_A3.get(code);
    const name = (a2 && names?.of(a2)) || undefined;
    out.push({ code, label: name && name !== a2 ? `${name} (${code})` : code });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, locale));
}

/** Calling codes offered by the phone picker; +234 (Nigeria) is the default. */
export const DIAL_CODES: readonly { code: string; label: string }[] = [
  { code: "+234", label: "Nigeria +234" },
  { code: "+233", label: "Ghana +233" },
  { code: "+254", label: "Kenya +254" },
  { code: "+27", label: "South Africa +27" },
  { code: "+44", label: "United Kingdom +44" },
  { code: "+1", label: "US / Canada +1" },
];
export const DEFAULT_DIAL_CODE = "+234";

/** Normalise a locally typed phone number into E.164 (spaces, dashes, brackets and a leading 0 handled). */
export function normalizePhone(raw: string, dialCode: string = DEFAULT_DIAL_CODE): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits === "") return trimmed;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (trimmed.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) return `${dialCode}${digits.slice(1)}`;
  return `${dialCode}${digits}`;
}

export type Sep9Kind = "date" | "country" | "phone" | "email" | "isco" | "text";

export interface Sep9InputSpec {
  kind: Sep9Kind;
  field: Sep9Field | undefined;
  hint: string | null;
}

const HINTS: Record<string, string> = {
  "iso8601-date": "Format: YYYY-MM-DD, for example 1976-07-04",
  "iso3166-alpha3": "Pick a country; the 3-letter ISO code is stored, for example NGA",
  e164: "Format: +2348012345678 (a leading 0 is converted for you)",
  email: "Format: name@example.com",
  isco08: "Numeric ISCO-08 occupation code, for example 2512",
  "iso639-1": "2-letter language code, for example en",
};

/** Decide how a field renders. Names outside the SEP-9 catalogue stay plain text. */
export function sep9InputSpec(name: string): Sep9InputSpec {
  const field = sep9Field(name);
  if (!field || field.type === "binary" || field.choices) return { kind: "text", field: undefined, hint: null };
  const hint = field.encoding ? (HINTS[field.encoding] ?? null) : null;
  switch (field.encoding) {
    case "iso8601-date":
      return { kind: "date", field, hint };
    case "iso3166-alpha3":
      return { kind: "country", field, hint };
    case "e164":
      return { kind: "phone", field, hint };
    case "email":
      return { kind: "email", field, hint };
    case "isco08":
      return { kind: "isco", field, hint };
    default:
      return { kind: "text", field, hint };
  }
}

export interface Sep9Check {
  ok: boolean;
  reason?: string;
  /** Non-blocking notice, for example an already-expired ID. */
  warning?: string;
}

/** Validate a value with the shared @checkout/core rules plus date sanity checks. `today` is YYYY-MM-DD. */
export function checkSep9Value(name: string, value: string, today: string): Sep9Check {
  const { field } = sep9InputSpec(name);
  if (!field) return { ok: true };
  const result = validateSep9Value(field, value);
  if (!result.ok) return { ok: false, reason: result.reason };
  if (value === "") return { ok: true };
  if (name === "birth_date" && value > today) return { ok: false, reason: "date of birth cannot be in the future" };
  if (name === "id_expiration_date" && value < today) return { ok: true, warning: "this ID has already expired" };
  return { ok: true };
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
