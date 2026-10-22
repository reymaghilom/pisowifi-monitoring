"use client";

import { useState } from "react";
import Link from "next/link";
import { PASSWORD_RESET_TTL_MINUTES } from "@pisowifi/shared";
import { DATA_SOURCE, getServices } from "@/lib/services";
import { toast } from "@/stores/toast-store";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/form";

const DEMO = DATA_SOURCE === "mock";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  if (sent)
    return (
      <>
        <span className="pw-ev-ic ok" style={{ width: 52, height: 52 }}>
          <Icon name="mail" size={24} />
        </span>
        <div>
          <h1 className="pw-h1">Check your email</h1>
          <p className="pw-muted" style={{ marginTop: 6 }}>
            {DEMO ? (
              <>
                If an account exists for <strong>{email}</strong>, reset instructions would be sent. Nothing was actually sent in this prototype.
              </>
            ) : (
              <>
                If an account exists for <strong>{email}</strong>, we sent a link to reset your password. It works once and expires in{" "}
                {PASSWORD_RESET_TTL_MINUTES} minutes.
              </>
            )}
          </p>
        </div>
        {DEMO ? (
          <Button onClick={() => toast("Nothing was sent. Prototype only.")}>Resend (demo)</Button>
        ) : (
          <Button
            onClick={async () => {
              const res = await getServices().auth.requestPasswordReset(email);
              toast(res.ok ? "If the account exists, a new link is on its way." : res.error);
            }}
          >
            Resend
          </Button>
        )}
        <Link href="/login" className="pw-btn ghost">
          Back to sign in
        </Link>
      </>
    );

  return (
    <>
      <div>
        <h1 className="pw-h1">Reset your password</h1>
        <p className="pw-muted" style={{ marginTop: 6 }}>
          {DEMO
            ? "Enter your email and we will describe the next step. Prototype only, no email is sent."
            : "Enter your email and we'll send you a link to choose a new password."}
        </p>
      </div>
      <form
        className="pw-stack"
        style={{ gap: 16 }}
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await getServices().auth.requestPasswordReset(email);
          if (!res.ok) return setErr(res.error);
          setSent(true);
        }}
      >
        <TextField
          id="f-email"
          label="Email"
          value={email}
          onValue={(v) => {
            setEmail(v);
            setErr("");
          }}
          error={err}
          placeholder="you@example.com"
          autoComplete="email"
        />
        <Button variant="primary" block type="submit" icon="mail" style={{ minHeight: 46 }}>
          Send reset link
        </Button>
      </form>
      <Link href="/login" className="pw-btn ghost">
        Back to sign in
      </Link>
    </>
  );
}
