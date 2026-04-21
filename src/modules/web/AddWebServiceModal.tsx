import { useEffect, useMemo, useState } from 'react';

import type { WebChatService } from '../../settings/store';
import { Button } from '../../shared/ui/Button';
import { Input } from '../../shared/ui/Input';
import { Modal } from '../../shared/ui/Modal';

import {
  defaultLabelFromUrl,
  isEmbeddableUrl,
  slugify,
  uniqueServiceId,
} from './webServiceUtils';

type Props = {
  open: boolean;
  onClose: () => void;
  existing: readonly WebChatService[];
  initialUrl?: string;
  initialLabel?: string;
  /// Title to show on the dialog. Defaults to "Add web tab".
  title?: string;
  onAdd: (service: WebChatService) => void;
};

/// Inline "add a web tab" dialog used by the AI tab's `+` button and by
/// EmbeddedWebChat's "Save as tab" button. Parent supplies prefill + the
/// current service list (for id collision avoidance).
export const AddWebServiceModal = ({
  open,
  onClose,
  existing,
  initialUrl = '',
  initialLabel = '',
  title = 'Add web tab',
  onAdd,
}: Props) => {
  const [url, setUrl] = useState(initialUrl);
  const [label, setLabel] = useState(initialLabel);
  const [touchedLabel, setTouchedLabel] = useState(initialLabel.length > 0);

  // Reset the form each time the modal opens so a stale draft from a previous
  // invocation doesn't bleed through. Prefill values drive the reset.
  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl);
    setLabel(initialLabel);
    setTouchedLabel(initialLabel.length > 0);
  }, [open, initialUrl, initialLabel]);

  const urlValid = isEmbeddableUrl(url);
  const effectiveLabel = useMemo(() => {
    if (label.trim().length > 0) return label.trim();
    return defaultLabelFromUrl(url);
  }, [label, url]);

  const canSubmit = urlValid && effectiveLabel.length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const base = slugify(effectiveLabel);
    const id = uniqueServiceId(base, existing);
    onAdd({ id, label: effectiveLabel, url: url.trim() });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={title}
      maxWidth={440}
      panelClassName="pane modal-surface rounded-xl p-4"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="flex flex-col gap-3"
      >
        <div className="t-primary text-title">{title}</div>
        <label className="flex flex-col gap-1">
          <span className="t-secondary text-meta">URL</span>
          <Input
            aria-label="Service URL"
            placeholder="https://"
            value={url}
            autoFocus
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="t-secondary text-meta">Label</span>
          <Input
            aria-label="Service label"
            placeholder={defaultLabelFromUrl(url) || 'e.g. Claude'}
            value={label}
            onChange={(e) => {
              setTouchedLabel(true);
              setLabel(e.currentTarget.value);
            }}
          />
          {!touchedLabel && defaultLabelFromUrl(url) && (
            <span className="t-tertiary text-meta">
              Auto: {defaultLabelFromUrl(url)} — you can change it anytime.
            </span>
          )}
        </label>
        {url.trim().length > 0 && !urlValid && (
          <div className="t-danger text-meta" role="alert">
            URL must start with http:// or https://.
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="soft"
            tone="accent"
            disabled={!canSubmit}
          >
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
};
