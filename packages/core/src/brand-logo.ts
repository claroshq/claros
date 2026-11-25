/**
 * Uploaded brand logo rules (v0.8.5): accepted formats, size limit, image
 * header parsing and the default logo height. Pure logic; the upload route
 * is packages/api/src/routes/brand.ts.
 *
 * Only PNG and JPEG are accepted: both render in every mail client, and
 * neither can carry script (SVG is refused). The format is decided by the
 * file's magic bytes, and the declared Content-Type must agree.
 */

/** Largest accepted logo, in bytes. */
export const BRAND_LOGO_MAX_BYTES = 256 * 1024;

/** Content types accepted for an uploaded logo. */
export const BRAND_LOGO_TYPES = ["image/png", "image/jpeg"] as const;
export type BrandLogoType = (typeof BRAND_LOGO_TYPES)[number];

/** Height the email shell gives a logo when brand.logo_height is unset by an upload. */
export const BRAND_LOGO_DEFAULT_MAX_HEIGHT = 48;
/** Widest a defaulted logo may render, in CSS pixels. */
export const BRAND_LOGO_DEFAULT_MAX_WIDTH = 240;

export interface BrandLogoInfo {
  contentType: BrandLogoType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}

function u32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}

/** PNG: signature, then the IHDR chunk (width and height, big-endian u32). */
function inspectPng(b: Uint8Array): BrandLogoInfo | null {
  if (b.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (b[i] !== PNG_SIGNATURE[i]) return null;
  // Chunk length (4), then type "IHDR".
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const width = u32(b, 16);
  const height = u32(b, 20);
  if (width === 0 || height === 0) return null;
  return { contentType: "image/png", width, height };
}

/**
 * JPEG: SOI (FF D8), then segments until a start-of-frame marker (SOF0 to
 * SOF15 except DHT C4, JPG C8 and DAC CC), which holds height and width.
 */
function inspectJpeg(b: Uint8Array): BrandLogoInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any frame header
    const length = u16(b, i + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      const height = u16(b, i + 5);
      const width = u16(b, i + 7);
      if (width === 0 || height === 0) return null;
      return { contentType: "image/jpeg", width, height };
    }
    i += 2 + length;
  }
  return null;
}

/** Format and dimensions from the image header, or null when it is not a readable PNG or JPEG. */
export function inspectBrandLogo(bytes: Uint8Array): BrandLogoInfo | null {
  return inspectPng(bytes) ?? inspectJpeg(bytes);
}

/**
 * brand.logo_height for an uploaded logo when none is set: the image's own
 * height, at most BRAND_LOGO_DEFAULT_MAX_HEIGHT, lowered so that the logo
 * is at most BRAND_LOGO_DEFAULT_MAX_WIDTH wide, and never below 16 (the
 * smallest brand.logo_height the settings accept).
 */
export function defaultBrandLogoHeight(width: number, height: number): number {
  const byWidth = (BRAND_LOGO_DEFAULT_MAX_WIDTH * height) / width;
  const h = Math.floor(Math.min(BRAND_LOGO_DEFAULT_MAX_HEIGHT, height, byWidth));
  return Math.max(16, h);
}
