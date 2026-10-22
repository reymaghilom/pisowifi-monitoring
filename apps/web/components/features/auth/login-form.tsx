"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DATA_SOURCE, getServices } from "@/lib/services";
import { hasErrors, validateLogin } from "@/lib/validation";
import { useDemo } from "@/stores/demo-store";
import { toast } from "@/stores/toast-store";
import { useHydrated } from "@/hooks/use-hydrated";
import { useSession } from "@/lib/session";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { PasswordField, TextField } from "@/components/ui/form";

const DEMO = DATA_SOURCE === "mock";

/** Email + password sign-in. Mock data source: any email with the password "demo" (prefilled). */
export function LoginForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const session = useSession((s) => s.status);
  const [email, setEmail] = useState(DEMO ? "operator@example.com" : "");
  const [pw, setPw] = useState(DEMO ? "demo" : "");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [fe, setFe] = useState<{ email?: string; pw?: string }>({});

  useEffect(() => {
    if (hydrated && (DEMO ? useDemo.getState().auth : session === "authenticated")) router.replace("/dashboard");
  }, [hydrated, session, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    const f = validateLogin(email, pw);
    setFe(f);
    if (hasErrors(f)) return;
    setLoading(true);
    const res = await getServices().auth.signIn({ email, password: pw, remember });
    setLoading(false);
    if (!res.ok) return setErr(res.error);
    router.replace("/dashboard");
    toast(DEMO ? "Signed in (demo)" : "Signed in");
  };

  return (
    <>
      <div>
        <h1 style={{ font: "650 26px/32px var(--font-sans)", letterSpacing: "-.015em" }}>Welcome back</h1>
        <p className="pw-muted" style={{ marginTop: 6 }}>
          Sign in to your PisoWiFi Monitoring workspace.
        </p>
      </div>
      <form className="pw-stack" style={{ gap: 16 }} noValidate onSubmit={submit}>
        {err && (
          <Banner kind="bad" icon="alert">
            <strong>{err}</strong>
          </Banner>
        )}
        <TextField
          id="l-email"
          label="Email"
          type="email"
          value={email}
          onValue={(v) => {
            setEmail(v);
            setErr("");
            setFe((x) => ({ ...x, email: undefined }));
          }}
          error={fe.email}
          autoComplete="username"
        />
        <PasswordField
          id="l-pw"
          label="Password"
          value={pw}
          onValue={(v) => {
            setPw(v);
            setErr("");
            setFe((x) => ({ ...x, pw: undefined }));
          }}
          error={fe.pw}
          autoComplete="current-password"
        />
        <div className="pw-row pw-between pw-wrap">
          <Checkbox checked={remember} onChange={setRemember}>
            Remember me
          </Checkbox>
          <Link href="/forgot-password" className="rowlink" style={{ color: "var(--brand)", fontSize: 13 }}>
            Forgot password?
          </Link>
        </div>
        <Button variant="primary" block type="submit" loading={loading} loadingText="Signing in…" style={{ minHeight: 46 }}>
          Sign in
        </Button>
      </form>
      {DEMO && (
        <Banner kind="info" icon="info">
          <span style={{ fontSize: 12 }}>
            Prototype sign-in. Use any email with the password <strong>demo</strong>. No account is checked.
          </span>
        </Banner>
      )}
    </>
  );
}
