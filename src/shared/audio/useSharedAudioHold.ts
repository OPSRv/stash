import { useEffect, useId } from 'react';
import { setSharedAudioHold } from './sharedAudioContext';

/** Keep the shared AudioContext awake while `active` (see the idle-suspend
 *  notes in `sharedAudioContext.ts`). One hold per hook instance, released on
 *  unmount. `label` only makes the key readable when debugging. */
export const useSharedAudioHold = (label: string, active: boolean): void => {
  const id = useId();
  const key = `${label}${id}`;
  useEffect(() => {
    if (!active) return;
    setSharedAudioHold(key, true);
    return () => setSharedAudioHold(key, false);
  }, [key, active]);
};
