import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { PWARegister } from "@/components/pwa-register";
import { TvSpatialNavigation } from "@/components/tv-spatial-navigation";
import { tvDetectionBootstrapScript } from "@/lib/tv-detect";
import { legacyStorageMigrationScript } from "@/lib/storage-migration";
import { appearanceBootstrapScript } from "@/lib/appearance";

const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

const montserrat = localFont({
  src: "./fonts/montserrat-latin.woff2",
  variable: "--font-montserrat",
  weight: "500 800",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Absolute Cinema",
    template: "%s · Absolute Cinema",
  },
  description: "Your personal streaming experience — movies and TV in one place.",
  keywords: ["movies", "streaming", "tv", "absolute cinema"],
  manifest: "/manifest.json?v=3",
  icons: {
    icon: [
      { url: "/favicon.svg?v=3", type: "image/svg+xml" },
      { url: "/favicon-32.png?v=3", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png?v=3", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png?v=3", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: "Absolute Cinema",
    description: "Your personal streaming experience — movies and TV in one place.",
    type: "website",
    images: [{ url: "/og-image.png?v=3", width: 1200, height: 630, alt: "Absolute Cinema" }],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050508",
  // Without this, iOS Safari returns 0 for env(safe-area-inset-bottom) and the
  // mobile dock (mobile-dock.tsx) overlaps the home indicator.
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Seeding the provider means the navbar and session-aware UI render on the
  // first paint instead of popping in after a client-side /api/auth/session.
  const session = await getServerSession(authOptions).catch(() => null);
  return (
    <html lang="en" className="dark" data-material="clear" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${montserrat.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* Must run before anything paints — it decides the root font size.
            See tvDetectionBootstrapScript() for why this cannot wait for React. */}
        <script dangerouslySetInnerHTML={{ __html: legacyStorageMigrationScript() }} />
        <script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript() }} />
        <script dangerouslySetInnerHTML={{ __html: tvDetectionBootstrapScript() }} />
        <Providers session={session}>
          {children}
          <PWARegister />
        </Providers>
        <Toaster />
        <TvSpatialNavigation />
      </body>
    </html>
  );
}
