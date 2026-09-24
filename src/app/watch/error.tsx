"use client";

import { AlertTriangle } from "lucide-react";
import { MessageCard } from "@/components/message-card";

/** Errors inside the watch page. */
export default function WatchError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-black px-4">
      <MessageCard
        icon={<AlertTriangle className="h-6 w-6 text-amber-300" />}
        title="The player hit a snag"
        actions={[
          { label: "Try again", onClick: reset, primary: true },
          { label: "Go home", href: "/" },
        ]}
      >
        Something went wrong opening the player. Trying again usually fixes it.
      </MessageCard>
    </div>
  );
}
