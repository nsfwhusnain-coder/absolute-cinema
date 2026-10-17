import type { Metadata } from "next";
import { HubDashboard } from "@/components/hub/hub-dashboard";

export const metadata: Metadata = {
  title: "Live",
  robots: { index: false, follow: false },
};

/** The live dashboard (docs/HUB.md): who is watching what, and how the server is coping. For the owner. */
export default function HubPage() {
  return <HubDashboard />;
}
