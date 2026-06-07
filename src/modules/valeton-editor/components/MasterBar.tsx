import { changeGlobalVol, changePatchVol } from '../lib/actions';
import { useStore } from '../store/store';
import { Fader } from './ui/Fader';

/** Майстер-гучності патча: глобальний рівень і рівень патча. Темпо-контрол
 *  винесено у картку DLY-блока (`TempoBar`), бо division/BPM керують саме
 *  часом затримки. */
export const MasterBar = () => {
  const locked = useStore((s) => s.locked);
  const globalVol = useStore((s) => s.globalVol);
  const patchVOL = useStore((s) => s.patchVOL);

  return (
    <div className="flex h-10 items-center gap-2 px-2.5">
      {/* Volume */}
      <Fader
        label="VOL"
        width={56}
        dataId="global_vol_value"
        disabled={locked}
        min={0}
        max={100}
        step={1}
        value={globalVol}
        onChange={(v) => changeGlobalVol(v)}
      />

      <span className="h-4 w-px bg-ve-stroke" />

      {/* Patch volume */}
      <Fader
        label="PATCH"
        width={56}
        dataId="patch_vol_value"
        disabled={locked}
        min={0}
        max={100}
        step={1}
        value={patchVOL}
        onChange={(v) => changePatchVol(v)}
      />
    </div>
  );
};
