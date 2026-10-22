import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { StoreSync } from "@/components/shell/theme-sync";
import { Toaster } from "@/components/ui/toaster";
import { ChartTooltip } from "@/components/charts/tooltip";
import "./globals.css";

const inter = localFont({ src: "./fonts/inter/InterVariable.woff2", variable: "--font-inter", weight: "100 900", style: "normal", display: "swap" });
const jetbrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono/JetBrainsMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono/JetBrainsMono-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PisoWiFi Monitoring",
  description: "Monitor registered WiFi5Soft PisoWiFi machines and manage authorized remote access.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* Applies the saved theme before first paint. "system" means no data-theme attribute (follows the OS). */
const themeScript = `(function(){try{var t=localStorage.getItem("pw-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <StoreSync />
        <Toaster />
        <ChartTooltip />
      </body>
    </html>
  );
}
