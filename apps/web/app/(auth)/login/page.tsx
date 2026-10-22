import type { Metadata } from "next";
import { LoginForm } from "@/components/features/auth/login-form";

export const metadata: Metadata = { title: "Sign in · PisoWiFi Monitoring" };

export default function Page() {
  return <LoginForm />;
}
