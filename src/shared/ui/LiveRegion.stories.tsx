import type { Meta, StoryObj } from '@storybook/react-vite';
import { LiveRegionProvider, useAnnounce } from './LiveRegion';
import { Button } from './Button';

const Demo = () => {
  const { announce } = useAnnounce();
  return (
    <div className="pane rounded-xl p-5 flex flex-col gap-3" style={{ width: 420 }}>
      <p className="t-secondary text-[13px]">
        Клацни кнопку — скрінрідер озвучить повідомлення. Сам регіон візуально прихований
        (1×1 px, clip-rect). Використовуй DevTools → Accessibility, щоб побачити вузол.
      </p>
      <div className="flex gap-2">
        <Button tone="accent" onClick={() => announce('Нотатку збережено')}>
          announce(polite)
        </Button>
        <Button tone="danger" onClick={() => announce('Помилка збереження', 'assertive')}>
          announce(assertive)
        </Button>
      </div>
    </div>
  );
};

const meta = {
  title: 'Feedback/LiveRegion',
  component: Demo,
  tags: ['autodocs'],
  parameters: { surface: 'plain' },
  decorators: [
    (Story) => (
      <LiveRegionProvider>
        <Story />
      </LiveRegionProvider>
    ),
  ],
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
