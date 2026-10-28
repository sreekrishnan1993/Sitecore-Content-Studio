import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./content-studio.css";

export const metadata: Metadata = {
  title: "Content Studio for Sitecore",
  description: "Turn PDFs, Word documents and publications into structured Sitecore content.",
};

export default function ContentStudioLayout({ children }: { children: ReactNode }) {
  return children;
}
