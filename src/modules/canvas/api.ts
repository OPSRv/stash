// IO boundary for the Canvas module. Frontend-only clipboard helpers for now
// (Copy visible / Paste image); disk persistence + file Save land with the
// Rust side (canvas.db + assets) in a later step. Components never reach for
// the Tauri plugins directly — they go through here.

import { invoke } from '@tauri-apps/api/core';
import { Image } from '@tauri-apps/api/image';
import { readImage, writeImage } from '@tauri-apps/plugin-clipboard-manager';

/** One persisted project row (scene_json is opaque to Rust). */
export interface ProjectRecord {
  id: string;
  title: string;
  scene_json: string;
  updated_at: number;
  sort_order: number;
}

export const canvasListProjects = (): Promise<ProjectRecord[]> =>
  invoke('canvas_list_projects');

export const canvasSaveProject = (rec: ProjectRecord): Promise<void> =>
  invoke('canvas_save_project', {
    id: rec.id,
    title: rec.title,
    sceneJson: rec.scene_json,
    updatedAt: rec.updated_at,
    sortOrder: rec.sort_order,
  });

export const canvasDeleteProject = (id: string): Promise<void> =>
  invoke('canvas_delete_project', { id });

/** Persist raster bytes (accepts a data-URL or bare base64) under an asset id. */
export const canvasSaveAsset = (assetId: string, dataBase64: string): Promise<void> =>
  invoke('canvas_save_asset', { assetId, dataBase64 });

/** Read an asset back as base64 (no data-URL prefix). */
export const canvasLoadAsset = (assetId: string): Promise<string> =>
  invoke('canvas_load_asset', { assetId });

/** Write a PNG (data-URL or base64) to an absolute path from the save dialog. */
export const canvasWritePng = (path: string, dataBase64: string): Promise<void> =>
  invoke('canvas_write_png', { path, dataBase64 });

/** Interactive region capture → base64 PNG (null if the user cancelled). */
export const canvasCaptureImage = (): Promise<string | null> =>
  invoke('canvas_capture_image');

/** Interactive region capture → OCR text to clipboard (null if cancelled). */
export const canvasCaptureText = (): Promise<string | null> =>
  invoke('canvas_capture_text');

/** Re-register the two global capture shortcuts (Tauri accelerator strings). */
export const canvasSetCaptureShortcuts = (image: string, text: string): Promise<void> =>
  invoke('canvas_set_capture_shortcuts', { image, text });

/** A decoded raster ready to drop onto the stage as an image node. */
export interface PastedImage {
  src: string;
  width: number;
  height: number;
}

/** Convert a PNG data-URL to bytes and put it on the system clipboard as an
 *  image — backs the "Copy visible" action. */
export const copyPngToClipboard = async (dataUrl: string): Promise<void> => {
  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  const image = await Image.fromBytes(bytes);
  await writeImage(image);
};

/** Read an image off the system clipboard and decode it into a data-URL +
 *  natural size. Returns null when the clipboard holds no image. */
export const readClipboardImage = async (): Promise<PastedImage | null> => {
  let img: Image;
  try {
    img = await readImage();
  } catch {
    return null;
  }
  try {
    const { width, height } = await img.size();
    if (!width || !height) return null;
    const rgba = await img.rgba();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const data = new Uint8ClampedArray(rgba);
    ctx.putImageData(new ImageData(data, width, height), 0, 0);
    return { src: canvas.toDataURL('image/png'), width, height };
  } catch {
    return null;
  }
};

/** Probe an image src (data-URL) for its natural size. */
export const probeImageSrc = (src: string): Promise<PastedImage | null> =>
  new Promise((resolve) => {
    const probe = new window.Image();
    probe.onload = () => resolve({ src, width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve(null);
    probe.src = src;
  });

/** Decode a File / Blob (drag-drop, file picker) into a data-URL + size. */
export const readImageFile = (file: Blob): Promise<PastedImage | null> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const probe = new window.Image();
      probe.onload = () => resolve({ src, width: probe.naturalWidth, height: probe.naturalHeight });
      probe.onerror = () => resolve(null);
      probe.src = src;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

/** Load an SVG file, render it to a 2× raster, and return it as a PNG image
 *  node source. Falls back to the viewBox / 512² when the SVG has no intrinsic
 *  size. */
export const rasterizeSvgFile = async (file: Blob): Promise<PastedImage | null> => {
  const text = await file.text();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (!w || !h) {
        const vb = text.match(/viewBox=["']([\d.\s-]+)["']/);
        if (vb) {
          const p = vb[1].split(/\s+/).map(Number);
          w = p[2];
          h = p[3];
        }
      }
      w = w || 512;
      h = h || 512;
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ src: canvas.toDataURL('image/png'), width: w, height: h });
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
};
