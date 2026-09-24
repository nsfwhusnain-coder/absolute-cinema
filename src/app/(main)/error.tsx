"use client";

import { AlertTriangle } from "lucide-react";
import { MessageCard } from "@/components/message-card";

/** Errors inside (main) pages; the navbar and footer stay on screen. */
export default function MainSegmentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 pt-20">
      <MessageCard
        icon={<AlertTriangle className="h-6 w-6 text-amber-300" />}
        title="This page couldn't load"
        actions={[
          { label: "Try again", onClick: reset, primary: true },
          { label: "Go home", href: "/" },
        ]}
      >
        Something went wrong while loading it. Try again, or head back home.
      </MessageCard>
    </div>
  );
}
