"use client";

import { useEffect, useState, useMemo } from "react";
import { api, CheckoutError, ProfileView } from "../../lib/api";
import { SEP9_NATURAL_PERSON_FIELDS } from "@checkout/core";
import { COUNTRY_NAMES } from "./countries";

const GROUPS = [
  { id: "name", label: "Name" },
  { id: "contact", label: "Contact" },
  { id: "address", label: "Address" },
  { id: "birth", label: "Birth" },
  { id: "tax", label: "Tax" },
  { id: "id_document", label: "ID document" },
  { id: "employment", label: "Employment" },
  { id: "other", label: "Other" }
] as const;

export default function RegistrationForm() {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    api.getProfile().then(p => {
      if (!active) return;
      setProfile(p);
      setValues(p.fields || {});
      setLoading(false);
      
      const filled = Object.keys(p.fields || {}).length;
      if (filled === 0) setExpanded(true);
    }).catch(e => {
      if (!active) return;
      setLoading(false);
      setExpanded(true);
      setErrorMsg(
        e instanceof CheckoutError && e.status === 503
          ? "The registration profile isn't available on this deployment."
          : "Failed to load profile.",
      );
    });
    return () => { active = false; };
  }, []);

  const fields = useMemo(() => {
    return SEP9_NATURAL_PERSON_FIELDS.filter(f => f.type !== "binary" && f.name !== "ip_address");
  }, []);

  const filledCount = useMemo(() => {
    return fields.filter(f => !!values[f.name]).length;
  }, [fields, values]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);
    setFieldErrors({});

    const changedFields: Record<string, string> = {};
    for (const f of fields) {
      const current = values[f.name] || "";
      const original = profile?.fields?.[f.name] || "";
      // The API rejects empty values and has no per-field delete (use "Delete my
      // data" for erasure), so a cleared field is simply not sent.
      if (current !== "" && current !== original) {
        changedFields[f.name] = current;
      }
    }

    if (Object.keys(changedFields).length === 0) {
      setSaving(false);
      setExpanded(false);
      return;
    }

    try {
      const updated = await api.saveProfile(changedFields);
      setProfile(updated);
      setValues(updated.fields || {});
      setExpanded(false);
    } catch (err) {
      if (err instanceof CheckoutError && err.status === 422) {
        const raw = err.details.fields;
        const invalidFields: Record<string, string> = {};
        if (raw && typeof raw === "object") {
          for (const [name, reason] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof reason === "string") invalidFields[name] = reason;
          }
        }
        setFieldErrors(invalidFields);
        setErrorMsg("Please fix the errors below.");
      } else if (err instanceof CheckoutError && err.status === 503) {
        setErrorMsg("The registration profile isn't available on this deployment.");
      } else {
        setErrorMsg("Failed to save profile.");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="panel"><p>Loading profile...</p></div>;
  }

  return (
    <section className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Finish registration</h2>
        <button className="btn btn--ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : "Edit profile"}
        </button>
      </div>

      <div style={{ marginBottom: "1rem", fontSize: "0.85rem", color: "var(--text-2, #6b7280)" }}>
        {filledCount} of {fields.length} common fields filled
      </div>

      {expanded && (
        <>
          <p style={{ fontSize: "0.9rem", color: "var(--text-2, #6b7280)", marginBottom: "1rem" }}>
            Your identity information is stored securely and encrypted. Nothing is sent to an anchor without your explicit consent. <a href="/privacy" className="linkbtn">Privacy Notice</a>
          </p>
          
          <form onSubmit={handleSave}>
            {GROUPS.map(group => {
              const groupFields = fields.filter(f => f.group === group.id);
              if (groupFields.length === 0) return null;

              return (
                <fieldset key={group.id} style={{ border: "none", padding: 0, margin: "0 0 1.5rem 0" }}>
                  <legend style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>{group.label}</legend>
                  <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                    {groupFields.map(f => {
                      const isCountry = f.encoding === "iso3166-alpha3";
                      const inputId = `reg-${f.name}`;
                      const error = fieldErrors[f.name];
                      const updated = profile?.updatedAt?.[f.name];
                      
                      let timeAgo = "";
                      if (updated) {
                        const days = Math.floor((Date.now() - updated) / (1000 * 60 * 60 * 24));
                        timeAgo = days === 0 ? "updated today" : `updated ${days} days ago`;
                      }

                      return (
                        <div key={f.name} className="field">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                            <label htmlFor={inputId}>{f.label}</label>
                            {timeAgo && <span style={{ fontSize: "0.75rem", color: "var(--text-2, #6b7280)" }}>{timeAgo}</span>}
                          </div>
                          
                          {isCountry ? (
                            <>
                              <input
                                list={`${inputId}-list`}
                                id={inputId}
                                value={values[f.name] || ""}
                                onChange={e => setValues({ ...values, [f.name]: e.target.value })}
                                aria-invalid={!!error}
                                placeholder="Type to search country..."
                              />
                              <datalist id={`${inputId}-list`}>
                                {Object.entries(COUNTRY_NAMES).map(([code, name]) => (
                                  <option key={code} value={code}>{name}</option>
                                ))}
                              </datalist>
                            </>
                          ) : f.choices ? (
                            <select
                              id={inputId}
                              value={values[f.name] || ""}
                              onChange={e => setValues({ ...values, [f.name]: e.target.value })}
                              aria-invalid={!!error}
                            >
                              <option value=""></option>
                              {f.choices.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : (
                            <input
                              id={inputId}
                              type={f.name === "mobile_number" ? "tel" : f.type === "date" ? "date" : "text"}
                              value={values[f.name] || ""}
                              onChange={e => setValues({ ...values, [f.name]: e.target.value })}
                              aria-invalid={!!error}
                            />
                          )}
                          
                          {error && <div style={{ color: "var(--clr-error, #ef4444)", fontSize: "0.8rem", marginTop: "0.25rem" }}>{error}</div>}
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}

            {errorMsg && <div className="err" style={{ marginBottom: "1rem" }}>{errorMsg}</div>}
            
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? "Saving..." : "Save Profile"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
