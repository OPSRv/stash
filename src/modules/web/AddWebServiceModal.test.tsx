import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { WebChatService } from '../../settings/store';

import { AddWebServiceModal } from './AddWebServiceModal';

const svc = (id: string): WebChatService => ({
  id,
  label: id,
  url: 'https://x',
});

describe('AddWebServiceModal', () => {
  test('disables Add until the URL is a valid http(s) URL', () => {
    render(
      <AddWebServiceModal
        open
        onClose={() => {}}
        existing={[]}
        onAdd={() => {}}
      />,
    );
    const addBtn = screen.getByRole('button', { name: 'Add' });
    expect(addBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Service URL'), {
      target: { value: 'not a url' },
    });
    expect(addBtn).toBeDisabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Service URL'), {
      target: { value: 'https://chat.openai.com' },
    });
    expect(addBtn).toBeEnabled();
  });

  test('auto-derives the label from the URL when the user leaves it blank', () => {
    const onAdd = vi.fn();
    render(
      <AddWebServiceModal
        open
        onClose={() => {}}
        existing={[]}
        onAdd={onAdd}
      />,
    );
    fireEvent.change(screen.getByLabelText('Service URL'), {
      target: { value: 'https://gemini.google.com/app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith({
      id: 'gemini',
      label: 'Gemini',
      url: 'https://gemini.google.com/app',
    });
  });

  test('deduplicates the id against existing services', () => {
    const onAdd = vi.fn();
    render(
      <AddWebServiceModal
        open
        onClose={() => {}}
        existing={[svc('gemini')]}
        onAdd={onAdd}
      />,
    );
    fireEvent.change(screen.getByLabelText('Service URL'), {
      target: { value: 'https://gemini.google.com/app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gemini-2', label: 'Gemini' }),
    );
  });

  test('honours a user-typed label over the URL heuristic', () => {
    const onAdd = vi.fn();
    render(
      <AddWebServiceModal
        open
        onClose={() => {}}
        existing={[]}
        onAdd={onAdd}
      />,
    );
    fireEvent.change(screen.getByLabelText('Service URL'), {
      target: { value: 'https://chat.openai.com' },
    });
    fireEvent.change(screen.getByLabelText('Service label'), {
      target: { value: 'ChatGPT' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith({
      id: 'chatgpt',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
    });
  });

  test('prefill seeds both fields and Add is enabled immediately', () => {
    const onAdd = vi.fn();
    render(
      <AddWebServiceModal
        open
        onClose={() => {}}
        existing={[]}
        initialUrl="https://chat.openai.com/c/abc123"
        initialLabel="My thread"
        onAdd={onAdd}
      />,
    );
    expect(screen.getByLabelText('Service URL')).toHaveValue(
      'https://chat.openai.com/c/abc123',
    );
    expect(screen.getByLabelText('Service label')).toHaveValue('My thread');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledWith({
      id: 'my-thread',
      label: 'My thread',
      url: 'https://chat.openai.com/c/abc123',
    });
  });
});
