import type { Metadata } from "next";
import { LoginView } from "@/views/login";

export const metadata: Metadata = {
  title: "Join",
  robots: { index: false, follow: false },
};

/** An invite link (src/lib/invites.ts): opens the sign-up form, with the invite that lets it through. */
export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <LoginView invite={code} />;
}
