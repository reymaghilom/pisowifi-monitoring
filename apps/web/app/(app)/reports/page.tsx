import { redirect } from "next/navigation";

/* Reports & Analytics is not offered (removed from navigation). The page code (components/features/reports) is kept
   for possible future use; the route sends people to the Dashboard, which shows the measured uptime and status changes. */
export default function ReportsPage() {
  redirect("/dashboard");
}
