import type { Metadata } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { Toaster } from "@/components/ui/sonner";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cormorant",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Velaris — The City at Night",
    template: "%s · Velaris",
  },
  description:
    "A fantasy-inspired AI agent orchestration platform. Houses (agents), quests (tasks), and messenger birds (approvals).",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${cormorant.variable} ${inter.variable} min-h-screen font-sans antialiased`}
      >
        <div className="flex min-h-screen">
          <AppSidebar />
          <div className="flex min-h-screen flex-1 flex-col">
            <AppTopbar />
            <main className="flex-1 overflow-y-auto px-6 py-6 md:px-10">{children}</main>
          </div>
        </div>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
