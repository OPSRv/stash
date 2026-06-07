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
    <div className="flex items-center gap-3 px-2.5">
      {/* Volume */}
      <Fader
        label="VOL"
        inline
        width={132}
        dataId="global_vol_value"
        disabled={locked}
        min={0}
        max={100}
        step={1}
        value={globalVol}
        onChange={(v) => changeGlobalVol(v)}
      />

      <span className="h-4 w-px bg-white/15" />

      {/* Patch volume */}
      <Fader
        label="PATCH"
        inline
        width={132}
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
