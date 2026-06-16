import { NumberInput } from '../../shared/ui/NumberInput';
import { Toggle } from '../../shared/ui/Toggle';
import { SegmentedControl } from '../../shared/ui/SegmentedControl';
import { accent } from '../../shared/theme/accent';
import { ColorField } from './ColorField';
import { BACKDROP_PRESETS, presetSwatch } from './backdrop';
import { canvasStore } from './store';
import type { CanvasNode, CanvasProject } from './types';

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-meta t-tertiary">{label}</span>
    {children}
  </div>
);

// Compact number field — no ± stepper (scroll-to-nudge + typing instead), so
// the dense Inspector rows stay clean and the value gets the full width.
const Num = (p: React.ComponentProps<typeof NumberInput>) => (
  <NumberInput size="sm" hideStepper {...p} />
);

interface Props {
  project: CanvasProject;
  selectedIds: string[];
}

export const Inspector = ({ project, selectedIds }: Props) => {
  const selected = project.nodes.filter((n) => n.id !== undefined && selectedIds.includes(n.id));
  const node = selected[0] as CanvasNode | undefined;

  if (!node) return <BackdropPanel project={project} />;

  const ids = selected.map((n) => n.id);
  const setStyle = (patch: Partial<CanvasNode['style']>) =>
    canvasStore.updateStyle(project.id, ids, patch);
  const s = node.style;
  const hasStroke = node.tool !== 'image' && node.tool !== 'erase' && node.tool !== 'blur';
  const hasFill = node.tool === 'rect' || node.tool === 'oval' || node.tool === 'erase' || node.tool === 'counter';

  return (
    <div className="flex flex-col gap-3.5 px-3 py-3.5">
      <div className="text-meta t-tertiary">
        {selected.length > 1 ? `${selected.length} layers` : node.name}
      </div>

      {node.tool === 'text' && (
        <ColorField label="Text colour" value={s.stroke} onChange={(stroke) => setStyle({ stroke })} />
      )}
      {hasStroke && node.tool !== 'text' && (
        <ColorField
          label={node.tool === 'highlighter' ? 'Colour' : 'Stroke'}
          value={s.stroke}
          onChange={(stroke) => setStyle({ stroke })}
        />
      )}
      {hasFill && (
        <ColorField label="Fill" value={s.fill} onChange={(fill) => setStyle({ fill })} allowTransparent />
      )}

      {hasStroke && node.tool !== 'text' && node.tool !== 'highlighter' && (
        <Field label="Width">
          <Num value={s.strokeWidth} onChange={(v) => setStyle({ strokeWidth: v ?? 1 })} min={1} max={60} step={1} size="sm" ariaLabel="Stroke width" />
        </Field>
      )}
      {node.tool === 'text' && (
        <Field label="Size">
          <Num value={s.fontSize ?? 24} onChange={(v) => setStyle({ fontSize: v ?? 12 })} min={8} max={200} step={1} size="sm" ariaLabel="Font size" />
        </Field>
      )}
      {node.tool === 'rect' && (
        <Field label="Radius">
          <Num value={s.radius ?? 0} onChange={(v) => setStyle({ radius: v ?? 0 })} min={0} max={200} step={1} size="sm" ariaLabel="Corner radius" />
        </Field>
      )}
      {node.tool === 'blur' && (
        <Field label="Blur">
          <Num value={s.blur ?? 12} onChange={(v) => setStyle({ blur: v ?? 1 })} min={1} max={60} step={1} size="sm" ariaLabel="Blur strength" />
        </Field>
      )}
      {node.tool === 'arrow' && (
        <Field label="Arrowhead">
          <Toggle checked={s.arrowHead ?? true} onChange={(arrowHead) => setStyle({ arrowHead })} />
        </Field>
      )}
      {(node.tool === 'rect' || node.tool === 'oval' || node.tool === 'line' || node.tool === 'arrow') && (
        <Field label="Dashed">
          <Toggle checked={s.dashed ?? false} onChange={(dashed) => setStyle({ dashed })} />
        </Field>
      )}
      <Field label="Opacity">
        <Num
          value={Math.round((s.opacity ?? 1) * 100)}
          onChange={(v) => setStyle({ opacity: Math.min(1, Math.max(0, (v ?? 100) / 100)) })}
          min={0}
          max={100}
          step={5}
          suffix="%"
          ariaLabel="Opacity"
        />
      </Field>
    </div>
  );
};

const BackdropPanel = ({ project }: { project: CanvasProject }) => {
  const b = project.backdrop;
  const set = (patch: Partial<typeof b>) => canvasStore.setBackdrop(project.id, patch);
  return (
    <div className="flex flex-col gap-3.5 px-3 py-3.5">
      <div className="flex items-center justify-between">
        <span className="text-meta t-tertiary">Backdrop</span>
        <Toggle checked={b.enabled} onChange={(enabled) => set({ enabled, preset: '__user__' })} />
      </div>

      {b.enabled && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {BACKDROP_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.label}
                aria-label={p.label}
                aria-pressed={b.preset === p.id}
                onClick={() => set({ fill: p.fill, preset: p.id })}
                className="h-7 w-7 rounded-md border hair"
                style={{
                  background: presetSwatch(p.fill),
                  boxShadow: b.preset === p.id ? `0 0 0 2px ${accent(0.9)}` : undefined,
                }}
              />
            ))}
          </div>

          <SegmentedControl
            size="sm"
            ariaLabel="Backdrop fill type"
            value={b.fill.kind}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'gradient', label: 'Gradient' },
            ]}
            onChange={(kind) =>
              set({
                preset: '__user__',
                fill:
                  kind === 'solid'
                    ? { kind: 'solid', color: b.fill.kind === 'solid' ? b.fill.color : b.fill.from }
                    : {
                        kind: 'gradient',
                        from: b.fill.kind === 'gradient' ? b.fill.from : b.fill.color,
                        to: b.fill.kind === 'gradient' ? b.fill.to : '#ec4899',
                        angle: b.fill.kind === 'gradient' ? b.fill.angle : 135,
                      },
              })
            }
          />

          {b.fill.kind === 'solid' ? (
            <ColorField label="Colour" value={b.fill.color} onChange={(color) => set({ fill: { kind: 'solid', color }, preset: '__user__' })} />
          ) : (
            <>
              <ColorField label="From" value={b.fill.from} onChange={(from) => set({ fill: { ...b.fill, from } as typeof b.fill, preset: '__user__' })} />
              <ColorField label="To" value={b.fill.to} onChange={(to) => set({ fill: { ...b.fill, to } as typeof b.fill, preset: '__user__' })} />
              <Field label="Angle">
                <Num value={b.fill.kind === 'gradient' ? b.fill.angle : 135} onChange={(v) => set({ fill: { ...b.fill, angle: v ?? 0 } as typeof b.fill, preset: '__user__' })} min={0} max={360} step={15} size="sm" suffix="°" ariaLabel="Gradient angle" />
              </Field>
            </>
          )}

          <Field label="Padding">
            <Num value={b.padding} onChange={(v) => set({ padding: v ?? 0 })} min={0} max={300} step={4} size="sm" ariaLabel="Padding" />
          </Field>
          <Field label="Radius">
            <Num value={b.radius} onChange={(v) => set({ radius: v ?? 0 })} min={0} max={120} step={2} size="sm" ariaLabel="Corner radius" />
          </Field>
          <Field label="Border">
            <Num value={b.border} onChange={(v) => set({ border: v ?? 0 })} min={0} max={40} step={1} size="sm" ariaLabel="Border width" />
          </Field>
          {b.border > 0 && (
            <ColorField label="Border colour" value={b.borderColor} onChange={(borderColor) => set({ borderColor })} />
          )}
        </>
      )}
    </div>
  );
};
