import type { Metadata } from "next";
import { ForgotForm } from "@/components/features/auth/forgot-form";

export const metadata: Metadata = { title: "Reset your password · PisoWiFi Monitoring" };

export default function Page() {
  return <ForgotForm />;
}
