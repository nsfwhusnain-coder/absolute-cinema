import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";

export function Footer() {
  return (
    <footer className="mt-auto px-6 pb-10 pt-16 text-center text-[0.8rem] text-muted-foreground">
      <div className="mb-5 flex items-center justify-center gap-4">
        <BrandMark size="nav" />
        <a
          href="https://github.com/nsfwhusnain-coder/absolute-cinema"
          target="_blank"
          rel="noreferrer"
          className="footer-social text-white/50 transition-colors hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
          aria-label="Absolute Cinema on GitHub"
        >
          <GitHubIcon className="h-[22px] w-[22px]" />
        </a>
      </div>

      {/* Muted-foreground token (not raw white/NN opacity) — keeps this text at
          WCAG AA contrast; tune via the token, not per-instance. */}
      <p className="mx-auto mb-4 max-w-[480px] leading-relaxed">
        Absolute Cinema does not host, store, or distribute any media files. All content is
        sourced from third-party providers.
      </p>

      <Link
        href="/dmca"
        className="mt-3 block text-[0.75rem] text-muted-foreground no-underline transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
      >
        DMCA
      </Link>
    </footer>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.6.3 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}
