// Scene (de)serialisation for disk persistence. Image bytes are NOT inlined in
// the saved JSON — they live as assets on disk, referenced by `assetId`. We
// strip `src` on save and rehydrate it from the asset store on load.

import { canvasLoadAsset } from './api';
import type { CanvasProject, ImageNode } from './types';

/** Serialise a project, replacing every image node's transient data-URL with
 *  an empty string so the row stays small. */
export const sceneToJson = (project: CanvasProject): string => {
  const stripped: CanvasProject = {
    ...project,
    nodes: project.nodes.map((n) =>
      n.tool === 'image' ? { ...(n as ImageNode), src: '' } : n,
    ),
  };
  return JSON.stringify(stripped);
};

/** Parse a stored scene and rehydrate image `src`s from disk assets. Returns
 *  null on a malformed row rather than throwing — one bad project must not
 *  block loading the rest. */
export const projectFromRecord = async (
  sceneJson: string,
): Promise<CanvasProject | null> => {
  let p: CanvasProject;
  try {
    p = JSON.parse(sceneJson) as CanvasProject;
  } catch {
    return null;
  }
  if (!p || !Array.isArray(p.nodes)) return null;

  const nodes = await Promise.all(
    p.nodes.map(async (n) => {
      if (n.tool !== 'image') return n;
      const img = n as ImageNode;
      if (img.src) return img; // already inline
      if (!img.assetId) return img;
      try {
        const b64 = await canvasLoadAsset(img.assetId);
        return { ...img, src: `data:image/png;base64,${b64}` } as ImageNode;
      } catch {
        return img; // asset missing — node renders empty, scene still loads
      }
    }),
  );
  return { ...p, nodes };
};
