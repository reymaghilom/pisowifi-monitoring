"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { getServices } from "@/lib/services";
import { hasErrors, validateNewPassword } from "@/lib/validation";
import { Icon } from "@/components/ui/icon";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { PasswordField } from "@/components/ui/form";

/** Token from the emailed link: /reset-password#token=… (a fragment, so it never reaches server logs). */
function readToken(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

const noop = () => () => {};

/** Choose a new password from a reset link (same layout as the forgot-password screen). */
export function ResetForm() {
  const inBrowser = useSyncExternalStore(noop, () => true, () => false);
  const [token] = useState(readToken);
  const [pw, setPw] = useState("");
  const [cf, setCf] = useState("");
  const [err, setErr] = useState<{ pw?: string; cf?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Drop the token from the address bar and history once read.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (done)
    return (
      <>
        <span className="pw-ev-ic ok" style={{ width: 52, height: 52 }}>
          <Icon name="check" size={24} />
        </span>
        <div>
          <h1 className="pw-h1">Password updated</h1>
          <p className="pw-muted" style={{ marginTop: 6 }}>
            Your new password is set and every device was signed out. Sign in with the new password.
          </p>
        </div>
        <Link href="/login" className="pw-btn primary" style={{ minHeight: 46 }}>
          Sign in
        </Link>
      </>
    );

  // Known only in the browser; the server render never shows the banner (no hydration mismatch).
  const missing = inBrowser && token === "";

  return (
    <>
      <div>
        <h1 className="pw-h1">Choose a new password</h1>
        <p className="pw-muted" style={{ marginTop: 6 }}>
          Use at least 12 characters. A long passphrase is easiest to remember.
        </p>
      </div>
      {(missing || err.form) && (
        <Banner kind="bad" icon="alert">
          <strong>{err.form ?? "This reset link is incomplete. Open the link from the email again, or request a new one."}</strong>
        </Banner>
      )}
      <form
        className="pw-stack"
        style={{ gap: 16 }}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const local = validateNewPassword(pw, cf);
          setErr(local);
          if (hasErrors(local) || !token) return;
          setLoading(true);
          const res = await getServices().auth.confirmPasswordReset(token, pw, cf);
          setLoading(false);
          if (!res.ok) return setErr(res.error);
          setDone(true);
        }}
      >
        <PasswordField
          id="r-pw"
          label="New password"
          value={pw}
          onValue={(v) => (setPw(v), setErr((x) => ({ ...x, pw: undefined })))}
          error={err.pw}
          help="At least 12 characters"
          autoComplete="new-password"
        />
        <PasswordField
          id="r-cf"
          label="Confirm password"
          value={cf}
          onValue={(v) => (setCf(v), setErr((x) => ({ ...x, cf: undefined })))}
          error={err.cf}
          autoComplete="new-password"
        />
        <Button variant="primary" block type="submit" loading={loading} loadingText="Saving…" disabled={missing} style={{ minHeight: 46 }}>
          Set new password
        </Button>
      </form>
      <Link href="/forgot-password" className="pw-btn ghost">
        Request a new link
      </Link>
    </>
  );
}
