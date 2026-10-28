import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodePng } from "@/src/lib/extraction/images";
import { isPublicAddress } from "@/src/lib/extraction/url-fetch";
import { downloadReferencedImages } from "@/src/lib/extraction/remote-images";
import type { ExtractedImage, ExtractionResult } from "@/src/lib/types/extraction";

// Publication images are downloaded through the SSRF-safe fetcher so they can be uploaded to the
// Media Library. "public.test" stands in for a public site served from loopback.
describe("downloading publication images", () => {
  let server: Server;
  let port: number;
  const photo = encodePng(new Uint8Array(96 * 96 * 3).fill(120), 96, 96, 3);
  const icon = encodePng(new Uint8Array(16 * 16 * 3).fill(10), 16, 16, 3);

  beforeAll(async () => {
    server = createServer((req, res) => {
      // The served Content-Type is deliberately wrong: the format comes from the file signature.
      if (req.url === "/hero.jpg" || req.url === "/second.png") res.writeHead(200, { "content-type": "application/octet-stream" }).end(photo);
      else if (req.url === "/icon.png") res.writeHead(200, { "content-type": "image/png" }).end(icon);
      else if (req.url === "/fake.png") res.writeHead(200, { "content-type": "image/png" }).end("<html>not an image</html>");
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const resolver = async (host: string) => {
    if (host === "public.test") return [{ address: "127.0.0.1", family: 4 }];
    if (host === "internal.test") return [{ address: "10.0.0.5", family: 4 }];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  const fetchOptions = () => ({ resolver, isAllowedAddress: (a: string) => a === "127.0.0.1" || isPublicAddress(a), allowedPorts: [String(port)] });

  const ref = (path: string, host = "public.test"): ExtractedImage => ({
    id: `img-${path}`,
    fileName: path.slice(1),
    mimeType: "",
    byteSize: 0,
    src: `http://${host}:${port}${path}`,
    origin: "referenced",
    sourceAltText: "Alt",
  });
  const result = (images: ExtractedImage[]): ExtractionResult => ({
    id: "ext",
    provider: "html",
    extractedAt: "2026-10-28T00:00:00Z",
    isSample: false,
    metadata: { fileName: "public.test/page", fileType: "html", fileSize: 1, wordCount: 1 },
    blocks: [],
    images,
    warnings: [],
  });

  it("downloads supported images, detects the real format and keeps the alt text", async () => {
    const out = await downloadReferencedImages(result([ref("/hero.jpg")]), { fetchOptions: fetchOptions() });
    expect(out.images).toHaveLength(1);
    expect(out.images[0]).toMatchObject({ origin: "extracted", mimeType: "image/png", fileName: "hero.png", width: 96, height: 96, byteSize: photo.byteLength, sourceAltText: "Alt" });
    expect(out.images[0].src.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it("keeps failures as links with a warning, and drops icons", async () => {
    const out = await downloadReferencedImages(result([ref("/missing.png"), ref("/fake.png"), ref("/icon.png"), ref("/second.png")]), { fetchOptions: fetchOptions() });
    expect(out.images.map((i) => [i.fileName, i.origin])).toEqual([
      ["missing.png", "referenced"],
      ["fake.png", "referenced"],
      ["second.png", "extracted"],
    ]);
    expect(out.warnings.map((w) => w.message).join(" ")).toMatch(/2 image\(s\) are only linked.*missing\.png could not be downloaded.*fake\.png is not a PNG/);
    expect(out.warnings.map((w) => w.message).join(" ")).toContain("1 icon-sized image(s) were left out");
  });

  it("never fetches private addresses", async () => {
    const out = await downloadReferencedImages(result([ref("/hero.jpg", "internal.test")]), { fetchOptions: fetchOptions() });
    expect(out.images[0].origin).toBe("referenced");
  });

  it("keeps the total under the size budget, first images first", async () => {
    const out = await downloadReferencedImages(result([ref("/hero.jpg"), ref("/second.png")]), { fetchOptions: fetchOptions(), maxTotalBytes: photo.byteLength });
    expect(out.images.map((i) => i.origin)).toEqual(["extracted", "referenced"]);
    expect(out.warnings.some((w) => w.code === "images-truncated")).toBe(true);
  });

  it("leaves documents without referenced images unchanged", async () => {
    const input = result([]);
    expect(await downloadReferencedImages(input)).toBe(input);
  });
});
