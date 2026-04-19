import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { TranslationBanner } from './TranslationBanner';

describe('TranslationBanner', () => {
  it('renders original, translated text and the target language pill', () => {
    render(
      <TranslationBanner
        original="Hello"
        translated="Привіт"
        to="uk"
        onDismiss={() => {}}
      />
    );
    expect(screen.getByText('Привіт')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText(/→ uk/i)).toBeInTheDocument();
  });

  it('copies the translation into the clipboard when Copy is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(writeText).mockClear();
    render(
      <TranslationBanner
        original="Hello"
        translated="Привіт"
        to="uk"
        onDismiss={() => {}}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('Привіт');
  });

  it('fires onDismiss when the close button is pressed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <TranslationBanner
        original="Hello"
        translated="Привіт"
        to="uk"
        onDismiss={onDismiss}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
