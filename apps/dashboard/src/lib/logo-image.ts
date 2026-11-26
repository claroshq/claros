/**
 * Browser side of logo background removal: decode an uploaded file into
 * pixels, and encode processed pixels back into a PNG file. The pixel
 * logic is in logo-background.ts.
 */
import { analyzeLogo, lowContrastShare, removeBackground, type LogoAnalysis, type RemoveOptions, type Rgb } from "./logo-background.js";

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

/** Decode a PNG or JPEG file and analyze its background. Null when the browser cannot decode it. */
export async function decodeLogo(file: File): Promise<DecodedLogo | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
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

function toBlob(el: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    el.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))), "image/png"),
  );
}

/**
 * The logo with its background removed, as a PNG file named after the
 * original. When the PNG is larger than maxBytes and the image is wider
 * than FALLBACK_MAX_WIDTH, it is scaled down to that width once.
 * lowContrast is lowContrastShare of the result on the dark mail body.
 */
export async function transparentLogo(
  original: File,
  decoded: DecodedLogo,
  background: Rgb,
  options: RemoveOptions,
  maxBytes: number,
): Promise<{ file: File; lowContrast: number }> {
  const { data, width, height } = decoded;
  const processed = removeBackground(data, width, height, background, options);
  const { el, ctx } = canvas(width, height);
  ctx.putImageData(new ImageData(processed.data, width, height), 0, 0);
  let blob = await toBlob(el);
  if (blob.size > maxBytes && width > FALLBACK_MAX_WIDTH) {
    const h = Math.max(1, Math.round((height * FALLBACK_MAX_WIDTH) / width));
    const small = canvas(FALLBACK_MAX_WIDTH, h);
    small.ctx.imageSmoothingQuality = "high";
    small.ctx.drawImage(el, 0, 0, FALLBACK_MAX_WIDTH, h);
    blob = await toBlob(small.el);
  }
  const name = original.name.replace(/\.(png|jpe?g)$/i, "") + ".png";
  return {
    file: new File([blob], name, { type: "image/png" }),
    lowContrast: lowContrastShare(processed.data, width, height),
  };
}
