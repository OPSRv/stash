import { useState } from 'react';
import { generatePreset } from '../../api';
import { importPreset, savePatchToDevice } from '../../lib/actions';
import { extractJsonObject, parsePreset } from '../../lib/presetIO';
import { useStore } from '../../store/store';
import { Modal } from '../ui/Modal';

type Msg = { kind: 'ok' | 'err' | 'info'; text: string };

/** AI-генератор пресетів. Зверху — поле з природномовним запитом
    («djent рітм», «тон Карлоса Сантани»); Generate шле його в Rust → LLM, і
    відповідь (JSON) лягає в редаговане поле нижче. Apply/Apply & Save
    застосовують пресет на поточний патч тим самим пайплайном, що й редактор. */
export const PresetAiModal = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const locked = useStore((s) => s.locked);
  const patchNumber = useStore((s) => s.currentPatchNumber);

  const [request, setRequest] = useState('');
  const [json, setJson] = useState('');
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);

  const patchLabel = String(patchNumber).padStart(2, '0');

  const generate = async () => {
    if (!request.trim() || generating) return;
    setGenerating(true);
    setMsg({ kind: 'info', text: 'Designing your tone…' });
    try {
      const raw = await generatePreset(request.trim());
      const extracted = extractJsonObject(raw);
      setJson(extracted);
      // Прев'ю-валідація, щоб одразу показати назву / попередження.
      const res = parsePreset(extracted);
      if (!res.ok) {
        setMsg({
          kind: 'err',
          text: `Model returned invalid JSON: ${res.error} — edit it below or regenerate.`,
        });
      } else {
        const conf =
          res.preset.confidence !== undefined
            ? ` · match ${Math.round(res.preset.confidence * 100)}%`
            : '';
        const note = res.preset.note ? ` — ${res.preset.note}` : '';
        setMsg({
          kind: 'ok',
          text: `Got "${res.preset.name ?? 'preset'}"${conf}${note}. Review, then apply to patch ${patchLabel}.`,
        });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `Generation failed: ${String(e)}` });
    } finally {
      setGenerating(false);
    }
  };

  const apply = async (save: boolean) => {
    if (busy) return;
    if (locked) {
      setMsg({
        kind: 'err',
        text: 'No GP-5 connected — connect via USB/Bluetooth first, then apply.',
      });
      return;
    }
    const res = parsePreset(json);
    if (!res.ok) {
      setMsg({ kind: 'err', text: res.error });
      return; // лишаємо відкритою, щоб показати помилку
    }
    setBusy(true);
    setMsg({ kind: 'info', text: 'Sending to the GP-5…' });
    try {
      const started = importPreset(res.preset);
      if (started === false) {
        setMsg({
          kind: 'err',
          text: 'Connect a GP-5 first — applying needs a live device.',
        });
        return;
      }
      // Дочекатися, поки вся (розріджена) пачка команд відправиться на пристрій,
      // тоді короткий settle і лише потім запис у слот — інакше зберігається
      // неповний/дефолтний edit-buffer.
      await started;
      if (save) {
        await new Promise((r) => setTimeout(r, 200));
        await savePatchToDevice({ skipConfirm: true });
      }
      onClose();
    } catch (e) {
      setMsg({ kind: 'err', text: `Apply failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const msgColor =
    msg?.kind === 'ok'
      ? 'text-ve-accent'
      : msg?.kind === 'err'
        ? 'text-ve-danger'
        : 'text-ve-dim';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI Preset"
      dataId="presetAiModal"
      footer={
        <>
          <button type="button" className="btn btn-soft" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            data-id="preset_ai_apply"
            className="btn btn-soft"
            disabled={busy || !json.trim()}
            onClick={() => apply(false)}
            title={locked ? 'Connect a GP-5 first' : undefined}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            data-id="preset_ai_apply_save"
            className="btn btn-primary"
            disabled={busy || !json.trim()}
            onClick={() => apply(true)}
            title={locked ? 'Connect a GP-5 first' : undefined}
          >
            {busy ? 'Applying…' : 'Apply & Save'}
          </button>
        </>
      }
    >
      <p className="mb-1 text-sm text-ve-dim">Describe the tone</p>
      <textarea
        data-id="preset_ai_request"
        className="h-16 w-full resize-y rounded-md border border-ve-stroke bg-ve-bg-2 p-2 text-sm text-ve-text placeholder:text-ve-dim/60 focus:border-ve-accent focus:outline-none disabled:opacity-50"
        placeholder="e.g. tight modern djent rhythm, drop-C — or: Carlos Santana lead tone"
        spellCheck={false}
        value={request}
        disabled={generating}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
        }}
      />
      <div className="mt-2">
        <button
          type="button"
          data-id="preset_ai_generate"
          className="btn btn-primary"
          disabled={generating || !request.trim()}
          onClick={generate}
        >
          {generating ? 'Generating…' : 'Generate'}
        </button>
      </div>

      <hr className="my-3 border-ve-stroke" />

      <p className="mb-1 text-sm text-ve-dim">Preset JSON</p>
      <textarea
        data-id="preset_ai_json"
        className="h-40 w-full resize-y rounded-md border border-ve-stroke bg-ve-bg-2 p-2 font-mono text-xs text-ve-text placeholder:text-ve-dim/60 focus:border-ve-accent focus:outline-none"
        placeholder="The generated preset JSON appears here — editable before you apply."
        spellCheck={false}
        value={json}
        onChange={(e) => {
          setJson(e.target.value);
          if (msg) setMsg(null);
        }}
      />
      {msg && (
        <p className={`mt-2 text-xs ${msgColor}`} data-id="preset_ai_msg">
          {msg.text}
        </p>
      )}
    </Modal>
  );
};
