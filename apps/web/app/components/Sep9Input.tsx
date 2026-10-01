"use client";

import { useMemo, useState } from "react";
import {
  checkSep9Value,
  countryOptions,
  DEFAULT_DIAL_CODE,
  DIAL_CODES,
  normalizePhone,
  sep9InputSpec,
  todayIso,
} from "../../lib/sep9-input";

/**
 * Field renderer for SEP-9 keys. Unknown (anchor-defined) fields fall back to a plain input.
 * Validation uses the same @checkout/core validators as the API. The parent owns the value and
 * is told about validity through onValidity so it can block submit.
 */
export default function Sep9Input({
  id,
  name,
  value,
  onChange,
  onValidity,
  invalid = false,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onValidity?: (name: string, error: string | null) => void;
  invalid?: boolean;
}) {
  const spec = useMemo(() => sep9InputSpec(name), [name]);
  const [touched, setTouched] = useState(false);
  const [dial, setDial] = useState(DEFAULT_DIAL_CODE);
  const countries = useMemo(() => (spec.kind === "country" ? countryOptions() : []), [spec.kind]);

  const check = spec.field ? checkSep9Value(name, value, todayIso()) : { ok: true as const };
  const error = !check.ok ? (check.reason ?? "invalid value") : null;
  const showError = touched && error !== null;
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [spec.hint ? hintId : null, showError ? errId : null, check.warning ? `${id}-warn` : null]
    .filter(Boolean)
    .join(" ") || undefined;

  function report(next: string) {
    const r = spec.field ? checkSep9Value(name, next, todayIso()) : { ok: true as const };
    onValidity?.(name, r.ok ? null : (r.reason ?? "invalid value"));
  }

  function blur() {
    setTouched(true);
    if (spec.kind === "phone") {
      const normalised = normalizePhone(value, dial);
      if (normalised !== value) onChange(normalised);
      report(normalised);
    } else {
      report(value);
    }
  }

  function change(next: string) {
    onChange(next);
    if (touched) report(next);
  }

  const common = {
    id,
    value,
    onBlur: blur,
    "aria-invalid": invalid || showError,
    "aria-describedby": describedBy,
    style: invalid || showError ? { borderColor: "var(--red)" } : undefined,
  } as const;

  let control;
  if (spec.kind === "date") {
    control = (
      <input
        {...common}
        type="date"
        max={name === "birth_date" ? todayIso() : undefined}
        onChange={(e) => change(e.target.value)}
      />
    );
  } else if (spec.kind === "country") {
    const listId = `${id}-countries`;
    const selected = countries.find((c) => c.code === value);
    control = (
      <>
        <input
          {...common}
          list={listId}
          autoComplete="off"
          placeholder="Start typing a country"
          value={selected ? selected.label : value}
          onChange={(e) => {
            const typed = e.target.value;
            const match = countries.find((c) => c.label.toLowerCase() === typed.trim().toLowerCase());
            change(match ? match.code : typed.trim().toUpperCase());
          }}
        />
        <datalist id={listId}>
          {countries.map((c) => (
            <option key={c.code} value={c.label} />
          ))}
        </datalist>
      </>
    );
  } else if (spec.kind === "phone") {
    control = (
      <div style={{ display: "flex", gap: 8 }}>
        <select aria-label="Country calling code" value={dial} onChange={(e) => setDial(e.target.value)}>
          {DIAL_CODES.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label}
            </option>
          ))}
        </select>
        <input {...common} type="tel" inputMode="tel" autoComplete="tel" onChange={(e) => change(e.target.value)} />
      </div>
    );
  } else if (spec.kind === "email") {
    control = <input {...common} type="email" autoComplete="email" onChange={(e) => change(e.target.value)} />;
  } else if (spec.kind === "isco") {
    control = (
      <input {...common} inputMode="numeric" pattern="\d{1,4}" onChange={(e) => change(e.target.value)} />
    );
  } else {
    control = <input {...common} onChange={(e) => change(e.target.value)} />;
  }

  return (
    <>
      {control}
      {spec.hint && (
        <div id={hintId} className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {spec.hint}
          {spec.kind === "isco" && (
            <>
              {" "}
              <a
                href="https://www.ilo.org/public/english/bureau/stat/isco/isco08/"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--blue)" }}
              >
                ISCO list
              </a>
            </>
          )}
        </div>
      )}
      {showError && (
        <div id={errId} className="err" role="alert">
          {error}
        </div>
      )}
      {!showError && check.warning && (
        <div id={`${id}-warn`} className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {check.warning}
        </div>
      )}
    </>
  );
}
