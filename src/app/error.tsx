"use client";

import { AlertTriangle } from "lucide-react";
import { MessageCard } from "@/components/message-card";

/** Errors thrown by the (main) or watch layouts. */
export default function RootSegmentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050508] px-4">
      <MessageCard
        icon={<AlertTriangle className="h-6 w-6 text-amber-300" />}
        title="Something went wrong"
        actions={[
          { label: "Try again", onClick: reset, primary: true },
          { label: "Go home", href: "/" },
        ]}
      >
        This page hit an unexpected error. Trying again usually fixes it.
      </MessageCard>
    </div>
  );
}
