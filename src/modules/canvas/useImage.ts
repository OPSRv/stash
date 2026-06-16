import { useEffect, useState } from 'react';

/** Load a data-URL / object-URL into an HTMLImageElement for Konva. Returns
 *  null until the image has decoded. Re-runs when `src` changes. */
export const useImage = (src: string | undefined): HTMLImageElement | null => {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (!cancelled) setImg(image);
    };
    image.onerror = () => {
      if (!cancelled) setImg(null);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return img;
};
