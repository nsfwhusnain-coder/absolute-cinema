import type { Metadata } from "next";
import { Film } from "lucide-react";
import { MessageCard } from "@/components/message-card";

export const metadata: Metadata = { title: "Page not found" };

export default function RootNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050508] px-4">
      <MessageCard icon={<Film className="h-6 w-6" />} title="Page not found" actions={[{ label: "Go home", href: "/", primary: true }]}>
        That page doesn&apos;t exist, or the link is broken.
      </MessageCard>
    </div>
  );
}
