/**
 * Uploaded logo rules: format and size from the image header, default height.
 */
import { describe, it, expect } from "vitest";
import { inspectBrandLogo, defaultBrandLogoHeight, wrapInShell } from "../src/index.js";

/** A real 120x30 PNG and the same image as a JPEG (JFIF + Exif before the frame header). */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAHgAAAAeCAIAAABoq03CAAAARUlEQVR42u3QQQ0AAAgEoCtjMuNbwhbOBxsJSPVwIApEi0a0aNEWRItGtGjRFkSLRrRo0YgWjWjRohEtGtGiRSNaNKI/Wks8Yl25h3DNAAAAAElFTkSuQmCC", "base64"));
const JPEG = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAeKADAAQAAAABAAAAHgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAHgB4AwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQACP/aAAwDAQACEQMRAD8A+f6KKK/04P5XCiiigAooooAKKKKACiiigAooooAKKKKACiiigD//0Pn+iiiv9OD+VwooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=", "base64"));

describe("inspectBrandLogo", () => {
  it("reads PNG and JPEG dimensions from the header", () => {
    expect(inspectBrandLogo(PNG)).toEqual({ contentType: "image/png", width: 120, height: 30 });
    expect(inspectBrandLogo(JPEG)).toEqual({ contentType: "image/jpeg", width: 120, height: 30 });
  });

  it("refuses SVG, GIF, WebP, truncated and empty files", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(inspectBrandLogo(text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))).toBeNull();
    expect(inspectBrandLogo(text("GIF89a\x01\x00\x01\x00"))).toBeNull();
    expect(inspectBrandLogo(text("RIFF\x00\x00\x00\x00WEBPVP8 "))).toBeNull();
    expect(inspectBrandLogo(PNG.subarray(0, 20))).toBeNull();
    expect(inspectBrandLogo(JPEG.subarray(0, 40))).toBeNull();
    expect(inspectBrandLogo(new Uint8Array())).toBeNull();
  });

  it("refuses a PNG with zero dimensions", () => {
    const zero = PNG.slice();
    zero.set([0, 0, 0, 0], 16);
    expect(inspectBrandLogo(zero)).toBeNull();
  });
});

describe("defaultBrandLogoHeight", () => {
  it("keeps the logo at most 48 px high and 240 px wide, never below 16", () => {
    expect(defaultBrandLogoHeight(512, 512)).toBe(48);
    expect(defaultBrandLogoHeight(600, 120)).toBe(48);
    expect(defaultBrandLogoHeight(1000, 100)).toBe(24);
    expect(defaultBrandLogoHeight(32, 32)).toBe(32);
    expect(defaultBrandLogoHeight(120, 30)).toBe(30);
    expect(defaultBrandLogoHeight(4000, 10)).toBe(16);
    expect(defaultBrandLogoHeight(8, 8)).toBe(16);
  });
});

describe("email shell with an uploaded logo", () => {
  it("renders the hosted logo URL and height", () => {
    const url = "https://news.example.com/brand/logo?v=0123456789ab";
    const html = wrapInShell({
      bodyHtml: "<p>Hi</p>",
      brand: { brand_name: "Acme", logo_url: url, logo_height: 30 },
      tenantName: "Acme Inc",
      complianceFooterHtml: "<p>footer</p>",
    });
    expect(html).toContain('<img src="https://news.example.com/brand/logo?v=0123456789ab" alt="Acme" height="30"');
  });
});
