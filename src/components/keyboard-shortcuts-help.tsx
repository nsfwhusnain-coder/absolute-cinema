"use client";

import { Fragment } from "react";
import { useUIStore } from "@/stores/ui-store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PLAYER_SHORTCUTS } from "@/lib/shortcuts";

const GLOBAL_SHORTCUTS = [{ key: "?", desc: "Show this help" }];


export function KeyboardShortcutsHelp() {
  const open = useUIStore((s) => s.shortcutsHelpOpen);
  const setOpen = useUIStore((s) => s.setShortcutsHelpOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="glass-strong max-w-md rounded-3xl border-0">
        <DialogHeader>
          <DialogTitle className="font-display">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ShortcutGroup title="Global" items={GLOBAL_SHORTCUTS} />
          <ShortcutGroup title="Player" items={PLAYER_SHORTCUTS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutGroup({ title, items }: { title: string; items: { key: string; desc: string }[] }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {items.map((s) => (
          <Fragment key={s.key}>
            <kbd className="justify-self-start rounded-lg bg-white/10 px-2 py-0.5 font-mono text-xs text-white">
              {s.key}
            </kbd>
            <span className="text-sm text-muted-foreground">{s.desc}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
