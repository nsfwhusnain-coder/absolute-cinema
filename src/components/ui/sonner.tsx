"use client";

import { Toaster as Sonner } from "sonner";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";

/** App-wide toasts, drawn with the same glass material as the rest of the UI. */
export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      offset={16}
      gap={8}
      icons={{
        success: <CheckCircle2 className="h-5 w-5 text-emerald-400" />,
        error: <XCircle className="h-5 w-5 text-red-400" />,
        warning: <AlertTriangle className="h-5 w-5 text-amber-400" />,
        info: <Info className="h-5 w-5 text-sky-400" />,
        loading: <Loader2 className="h-5 w-5 animate-spin text-white/80" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "glass-strong pointer-events-auto flex w-[min(92vw,24rem)] items-start gap-3 rounded-2xl px-4 py-3 text-sm text-white",
          title: "font-semibold leading-snug",
          description: "mt-0.5 text-white/70 leading-snug",
          actionButton: "ml-auto shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black",
          cancelButton: "shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white",
          icon: "mt-0.5 shrink-0",
        },
      }}
    />
  );
}
