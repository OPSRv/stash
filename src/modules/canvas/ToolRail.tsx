import { IconButton } from '../../shared/ui/IconButton';
import { accent } from '../../shared/theme/accent';
import { TOOLS } from './tools';
import type { ToolKind } from './types';

interface Props {
  tool: ToolKind;
  onPick: (t: ToolKind) => void;
}

/** Vertical tool palette. Every control is an IconButton with a title, so the
 *  Tooltip explains each glyph and the active tool reads via aria-pressed. */
export const ToolRail = ({ tool, onPick }: Props) => (
  <div className="flex flex-col items-center gap-0.5 border-r hair p-1.5">
    {TOOLS.map((t) => {
      const active = t.kind === tool;
      return (
        <div
          key={t.kind}
          className="rounded-md"
          style={active ? { background: accent(0.16), boxShadow: `inset 0 0 0 1px ${accent(0.28)}` } : undefined}
        >
          <IconButton
            title={`${t.title} (${t.hotkey.toUpperCase()})`}
            active={active}
            onClick={() => onPick(t.kind)}
          >
            {t.icon}
          </IconButton>
        </div>
      );
    })}
  </div>
);
