import { Film } from "lucide-react";
import { MessageCard } from "@/components/message-card";

/** Unknown titles, categories and routes inside the main layout. */
export default function MainNotFound() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 pt-20">
      <MessageCard icon={<Film className="h-6 w-6" />} title="Nothing here" actions={[{ label: "Go home", href: "/", primary: true }]}>
        That title or category doesn&apos;t exist, or the link is broken.
      </MessageCard>
    </div>
  );
}
