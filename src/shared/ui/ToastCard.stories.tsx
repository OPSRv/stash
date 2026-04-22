import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastCard } from './ToastCard';
import type { ToastItem } from './Toast.types';

const meta = {
  title: 'Feedback/ToastCard',
  component: ToastCard,
  tags: ['autodocs'],
  parameters: { surface: 'plain' },
} satisfies Meta<typeof ToastCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const base = (overrides: Partial<ToastItem> = {}): ToastItem => ({
  id: 1,
  title: 'Нотатку збережено',
  ...overrides,
});

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 360 }}>{children}</div>
);

export const Default: Story = {
  render: () => (
    <Stage>
      <ToastCard toast={base()} onDismiss={() => {}} />
    </Stage>
  ),
};

export const Success: Story = {
  render: () => (
    <Stage>
      <ToastCard
        toast={base({
          variant: 'success',
          title: 'Завантаження завершено',
          description: 'Файл збережено у ~/Downloads/stash.',
        })}
        onDismiss={() => {}}
      />
    </Stage>
  ),
};

export const Error: Story = {
  render: () => (
    <Stage>
      <ToastCard
        toast={base({
          variant: 'error',
          title: 'Не вдалося зʼєднатись',
          description: 'Перевір інтернет і спробуй ще раз.',
        })}
        onDismiss={() => {}}
      />
    </Stage>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Stage>
      <ToastCard
        toast={base({
          variant: 'success',
          title: 'Нотатку переміщено в архів',
          action: { label: 'Повернути', onClick: () => {} },
        })}
        onDismiss={() => {}}
      />
    </Stage>
  ),
};

export const LongDescription: Story = {
  render: () => (
    <Stage>
      <ToastCard
        toast={base({
          title: 'Довга розповідь на кілька рядків',
          description:
            'Опис може бути достатньо довгим, щоб перевірити, що line-clamp-3 обрізає текст і решта не розсовує картку. Останній рядок обривається трикрапкою.',
        })}
        onDismiss={() => {}}
      />
    </Stage>
  ),
};
