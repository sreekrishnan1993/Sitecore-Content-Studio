import type { NextConfig } from "next";

// Content Studio security headers (applied only to its own routes; starter routes are unchanged).
// frame-ancestors limits which hosts may embed the app. Headers are resolved at build time,
// so set CONTENT_STUDIO_FRAME_ANCESTORS before `next build` (space-separated sources).
const frameAncestors = process.env.CONTENT_STUDIO_FRAME_ANCESTORS?.trim() || "'self' https://*.sitecorecloud.io";

const contentStudioHeaders = [
  { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}; object-src 'none'; base-uri 'self'; form-action 'self'` },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
 pageExtensions: ['ts', 'tsx', 'js', 'jsx'],
  async headers() {
    return [
      { source: "/content-studio", headers: contentStudioHeaders },
      { source: "/content-studio/:path*", headers: contentStudioHeaders },
      { source: "/api/extract", headers: [...contentStudioHeaders, { key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
