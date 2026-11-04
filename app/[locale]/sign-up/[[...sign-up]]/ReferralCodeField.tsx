"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";

// The optional referral code on the sign-up page.
//
// Clerk draws the sign-up form itself, so the code cannot be one of its fields. It is checked
// against /api/referral-code instead, which parks the creator's handle in an httpOnly cookie that
// app/auth.ts reads (and checks again) once, when the account row is first created. Nothing here
// decides anything: a reader who skips it, or whose check fails, can still add a code from the
// dashboard for 7 days (app/referral-code.ts).
type State = { kind: "idle" } | { kind: "checking" } | { kind: "applied"; code: string } | { kind: "error"; message: string };

export default function ReferralCodeField() {
  const t = useTranslations("auth");
  const id = useId();
  const [value, setValue] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function apply(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setState({ kind: "checking" });
    try {
      const response = await fetch("/api/referral-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      if (response.ok && body.code) setState({ kind: "applied", code: body.code });
      else setState({ kind: "error", message: response.status === 404 || response.status === 422 ? t("referralNotFound") : t("referralFailed") });
    } catch {
      setState({ kind: "error", message: t("referralFailed") });
    }
  }

  async function remove() {
    setState({ kind: "idle" });
    setValue("");
    await fetch("/api/referral-code", { method: "DELETE" }).catch(() => {});
  }

  if (state.kind === "applied") {
    return (
      <div className="auth-referral auth-referral-applied" role="status">
        <span>{t("referralApplied", { code: state.code })}</span>
        <button type="button" onClick={remove}>{t("referralRemove")}</button>
      </div>
    );
  }
  return (
    <form
      className="auth-referral"
      onSubmit={(event) => { event.preventDefault(); void apply(value); }}
    >
      <label htmlFor={`${id}-code`}>{t("referralLabel")}</label>
      <div className="auth-referral-row">
        <input
          id={`${id}-code`}
          value={value}
          onChange={(event) => { setValue(event.target.value); if (state.kind === "error") setState({ kind: "idle" }); }}
          placeholder={t("referralPlaceholder")}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          aria-describedby={`${id}-hint`}
          aria-invalid={state.kind === "error" || undefined}
        />
        <button type="submit" disabled={!value.trim() || state.kind === "checking"}>
          {state.kind === "checking" ? t("referralChecking") : t("referralApply")}
        </button>
      </div>
      <small id={`${id}-hint`} className={state.kind === "error" ? "auth-referral-error" : undefined} role={state.kind === "error" ? "alert" : undefined}>
        {state.kind === "error" ? state.message : t("referralHint")}
      </small>
    </form>
  );
}
