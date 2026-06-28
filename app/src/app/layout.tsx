import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Knowledgebase Dashboard",
  description: "Manage domains, ingest files, run queries, and view evals.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
