import type { Metadata } from "next";
import { ResetForm } from "@/components/features/auth/reset-form";

export const metadata: Metadata = { title: "Choose a new password · PisoWiFi Monitoring" };

export default function Page() {
  return <ResetForm />;
}
