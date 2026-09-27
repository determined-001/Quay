import type { Sep9Field } from "./sep9";

// Full ISO 3166-1 alpha-3 official country codes set
export const ISO_3166_1_ALPHA_3_CODES: ReadonlySet<string> = new Set([
  "ABW", "AFG", "AGO", "AIA", "ALA", "ALB", "AND", "ARE", "ARG", "ARM", "ASM", "ATA", "ATF", "ATG", "AUS", "AUT", "AZE",
  "BDI", "BEL", "BEN", "BES", "BFA", "BGD", "BGR", "BHR", "BHS", "BIH", "BLM", "BLR", "BLZ", "BMU", "BOL", "BRA", "BRB", "BRN", "BTN", "BVT", "BWA",
  "CAF", "CAN", "CCK", "CHE", "CHL", "CHN", "CIV", "CMR", "COD", "COG", "COK", "COL", "COM", "CPV", "CRI", "CUB", "CUW", "CXR", "CYM", "CYP", "CZE",
  "DEU", "DJI", "DMA", "DNK", "DOM", "DZA",
  "ECU", "EGY", "ERI", "ESH", "ESP", "EST", "ETH",
  "FIN", "FJI", "FLK", "FRA", "FRO", "FSM",
  "GAB", "GBR", "GEO", "GGY", "GHA", "GIB", "GIN", "GLP", "GMB", "GNB", "GNQ", "GRC", "GRD", "GRL", "GTM", "GUF", "GUM", "GUY",
  "HKG", "HMD", "HND", "HRV", "HTI", "HUN",
  "IDN", "IMN", "IND", "IOT", "IRL", "IRN", "IRQ", "ISL", "ISR", "ITA",
  "JAM", "JEY", "JOR", "JPN",
  "KAZ", "KEN", "KGZ", "KHM", "KIR", "KNA", "KOR", "KWT",
  "LAO", "LBN", "LBR", "LBY", "LCA", "LIE", "LKA", "LSO", "LTU", "LUX", "LVA",
  "MAC", "MAF", "MAR", "MCO", "MDA", "MDG", "MDV", "MEX", "MHL", "MKD", "MLI", "MLT", "MMR", "MNE", "MNG", "MNP", "MOZ", "MRT", "MSR", "MTQ", "MUS", "MWI", "MYS", "MYT",
  "NAM", "NCL", "NER", "NFK", "NGA", "NIC", "NIU", "NLD", "NOR", "NPL", "NRU", "NZL",
  "OMN",
  "PAK", "PAN", "PCN", "PER", "PHL", "PLW", "PNG", "POL", "PRI", "PRK", "PRT", "PRY", "PSE", "PYF",
  "QAT",
  "REU", "ROU", "RUS", "RWA",
  "SAU", "SDN", "SEN", "SGP", "SGS", "SHN", "SJM", "SLB", "SLE", "SLV", "SMR", "SOM", "SPM", "SRB", "SSD", "STP", "SUR", "SVK", "SVN", "SWE", "SWZ", "SXM", "SYC", "SYR",
  "TCA", "TCD", "TGO", "THA", "TJK", "TKL", "TKM", "TLS", "TON", "TTO", "TUN", "TUR", "TUV", "TWN", "TZA",
  "UGA", "UKR", "UMI", "URY", "USA", "UZB",
  "VAT", "VCT", "VEN", "VGB", "VIR", "VNM", "VUT",
  "WLF", "WSM",
  "YEM",
  "ZAF", "ZMB", "ZWE"
]);

const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO639_1_REGEX = /^[a-z]{2}$/i;
const ISCO08_REGEX = /^\d{1,4}$/;

function isValidDate(dateStr: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return false;
  }
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);

  if (month < 1 || month > 12) {
    return false;
  }

  // Days per month
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysInMonth[month - 1];
  if (maxDay === undefined) {
    return false;
  }

  return day >= 1 && day <= maxDay;
}

export type Sep9ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateSep9Value(field: Sep9Field, value: unknown): Sep9ValidationResult {
  if (field.type === "binary") {
    return { ok: false, reason: "binary fields are not accepted as strings" };
  }

  if (value === null || value === undefined || value === "") {
    return { ok: false, reason: `Value for ${field.name} cannot be empty` };
  }

  const strValue = String(value).trim();

  // Choices check
  if (field.choices && field.choices.length > 0) {
    const matched = field.choices.some((c) => c.toLowerCase() === strValue.toLowerCase());
    if (!matched) {
      return {
        ok: false,
        reason: `Value '${strValue}' is not among allowed choices: ${field.choices.join(", ")}`,
      };
    }
  }

  // Date type check
  if (field.type === "date" || field.encoding === "iso8601-date") {
    if (!isValidDate(strValue)) {
      return { ok: false, reason: `Invalid ISO-8601 calendar date for ${field.name}: '${strValue}'` };
    }
  }

  // Encoding checks
  switch (field.encoding) {
    case "iso3166-alpha3": {
      const upper = strValue.toUpperCase();
      if (!ISO_3166_1_ALPHA_3_CODES.has(upper)) {
        return { ok: false, reason: `Invalid ISO 3166-1 alpha-3 country code: '${strValue}'` };
      }
      break;
    }
    case "e164": {
      if (!E164_REGEX.test(strValue)) {
        return { ok: false, reason: `Invalid E.164 phone number: '${strValue}' (expected format e.g. +2348012345678)` };
      }
      break;
    }
    case "email": {
      if (!EMAIL_REGEX.test(strValue)) {
        return { ok: false, reason: `Invalid email address format: '${strValue}'` };
      }
      break;
    }
    case "iso639-1": {
      if (!ISO639_1_REGEX.test(strValue)) {
        return { ok: false, reason: `Invalid ISO 639-1 two-letter language code: '${strValue}'` };
      }
      break;
    }
    case "isco08": {
      if (!ISCO08_REGEX.test(strValue)) {
        return { ok: false, reason: `Invalid ISCO-08 numeric occupation code: '${strValue}'` };
      }
      break;
    }
    default:
      break;
  }

  return { ok: true };
}
