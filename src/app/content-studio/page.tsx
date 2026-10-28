"use client";

import dynamic from "next/dynamic";

// Content Studio is a browser-only workspace (Marketplace SDK, drag and drop, session storage),
// so it is rendered on the client only.
const ContentStudioApp = dynamic(() => import("@/src/components/shell/ContentStudioApp"), {
  ssr: false,
  loading: () => <p style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>Loading Content Studio…</p>,
});

export default function ContentStudioPage() {
  return <ContentStudioApp />;
}
