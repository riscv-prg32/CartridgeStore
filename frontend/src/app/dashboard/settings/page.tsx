import { redirect } from "next/navigation";

/** Runtime and publishing settings for the developer dashboard. */
export default function DashboardSettingsPage() {
  redirect("/dashboard/settings/general");
}
