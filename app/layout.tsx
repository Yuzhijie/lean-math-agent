import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lean Math Agent",
  description: "Interactive Lean 4 math problem solver",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
