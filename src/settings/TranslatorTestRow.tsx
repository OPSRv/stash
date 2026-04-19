import { useState } from 'react';
import { Button } from '../shared/ui/Button';
import { useToast } from '../shared/ui/Toast';
import { translate } from '../modules/translator/api';
import { SettingRow } from './SettingRow';

interface TranslatorTestRowProps {
  target: string;
}

/// One-click verification row: sends "Hello, how are you today?" through
/// the pipeline so the user can confirm translator connectivity without
/// leaving Settings.
export const TranslatorTestRow = ({ target }: TranslatorTestRowProps) => {
  const [result, setResult] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const { toast } = useToast();

  const run = async () => {
    setIsBusy(true);
    setResult(null);
    try {
      const translation = await translate('Hello, how are you today?', target);
      setResult(translation.translated);
      toast({ title: 'Translator works', description: translation.translated, variant: 'success' });
    } catch (error) {
      const message = String(error);
      setResult(`Error: ${message}`);
      toast({
        title: 'Translator test failed',
        description: message,
        variant: 'error',
        action: { label: 'Retry', onClick: () => void run() },
      });
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <SettingRow
      title="Test translator"
      description={
        result ??
        'Sends a short sentence through the pipeline to verify the network and target language.'
      }
      control={
        <Button variant="soft" size="sm" onClick={run} loading={isBusy}>
          {isBusy ? 'Testing…' : 'Run test'}
        </Button>
      }
    />
  );
};
