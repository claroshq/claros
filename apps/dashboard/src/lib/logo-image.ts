/**
 * Browser side of logo processing: decode an uploaded file into pixels, and
 * encode processed pixels back into PNG files. The pixel logic is in
 * logo-background.ts.
 */
import {
  analyzeLogo,
  darkVariant,
  lowContrastShare,
  removeBackground,
  type LogoAnalysis,
  type RemoveOptions,
  type Rgb,
} from "./logo-background.js";

export interface DecodedLogo {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  analysis: LogoAnalysis;
}

/** Widest a processed logo is kept when its PNG would exceed the size limit (3x the 240px the shell shows). */
const FALLBACK_MAX_WIDTH = 720;

function canvas(width: number, height: number): { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot read the image.");
  return { el, ctx };
}

async function decodeSource(source: Blob): Promise<DecodedLogo | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  const { ctx } = canvas(width, height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height, analysis: analyzeLogo(data, width, height) };
}

/** Decode a PNG or JPEG file and analyze its background. Null when the browser cannot decode it. */
export function decodeLogo(file: File): Promise<DecodedLogo | null> {
  return decodeSource(file);
}

function toBlob(el: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    el.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))), "image/png"),
  );
}

/**
 * Pixels as a PNG file. When the PNG is larger than maxBytes and the image
 * is wider than FALLBACK_MAX_WIDTH, it is scaled down to that width once.
 */
async function encodePng(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, name: string, maxBytes: number): Promise<File> {
  const { el, ctx } = canvas(width, height);
  ctx.putImageData(new ImageData(data, width, height), 0, 0);
  let blob = await toBlob(el);
  if (blob.size > maxBytes && width > FALLBACK_MAX_WIDTH) {
    const h = Math.max(1, Math.round((height * FALLBACK_MAX_WIDTH) / width));
    const small = canvas(FALLBACK_MAX_WIDTH, h);
    small.ctx.imageSmoothingQuality = "high";
    small.ctx.drawImage(el, 0, 0, FALLBACK_MAX_WIDTH, h);
    blob = await toBlob(small.el);
  }
  return new File([blob], name, { type: "image/png" });
}

function baseName(name: string): string {
  return name.replace(/\.(png|jpe?g)$/i, "") || "logo";
}

export interface PreparedLogo {
  /** The logo to upload: transparent when removal was asked for, else the original file. */
  logo: File;
  /** The dark-mode version, when asked for and the logo is transparent. */
  dark: File | null;
  /** lowContrastShare of the logo on the dark mail body (0 when it was not made transparent). */
  lowContrast: number;
}

/**
 * The files to upload for a chosen logo. With background, the background
 * is removed first (removeBackground); the dark-mode version is made from
 * the transparent pixels, so it is only offered for a logo that is (or was
 * made) transparent.
 */
export async function prepareLogo(
  original: File,
  decoded: DecodedLogo,
  options: { background: Rgb | null; remove: RemoveOptions; dark: boolean },
  maxBytes: number,
): Promise<PreparedLogo> {
  const { width, height } = decoded;
  const name = baseName(original.name);
  let pixels: Uint8ClampedArray = decoded.data;
  let logo = original;
  if (options.background) {
    const processed = removeBackground(decoded.data, width, height, options.background, options.remove);
    pixels = processed.data;
    logo = await encodePng(processed.data, width, height, `${name}.png`, maxBytes);
  }
  const transparent = options.background !== null || decoded.analysis.kind === "transparent";
  const lowContrast = transparent ? lowContrastShare(pixels, width, height) : 0;
  const dark = options.dark && transparent
    ? await encodePng(darkVariant(pixels, width, height), width, height, `${name}-dark.png`, maxBytes)
    : null;
  return { logo, dark, lowContrast };
}
