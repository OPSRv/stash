import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Intro',
  tags: ['autodocs'],
  parameters: { layout: 'centered', surface: 'plain' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Welcome: Story = {
  render: () => (
    <div className="pane rounded-xl p-6" style={{ maxWidth: 560 }}>
      <div className="t-primary text-heading font-semibold mb-2">Stash UI</div>
      <p className="t-secondary text-body mb-3">
        Жива колекція примітивів з <code>src/shared/ui/</code>. Єдине місце, де
        їх можна дивитись без Tauri-попапу.
      </p>
      <ul className="t-secondary text-body" style={{ paddingLeft: 18, listStyle: 'disc' }}>
        <li>
          <b>Тема</b> — перемикач у тулбарі (<code>dark</code> / <code>light</code>). Повністю повторює
          клас <code>html.light</code> з <code>tokens.css</code>.
        </li>
        <li>
          <b>Акцент</b> — тулбар оновлює <code>--stash-accent-rgb</code>; усі виклики{' '}
          <code>accent(α)</code> перекрашуються одразу.
        </li>
        <li>
          <b>Сцена</b> — pane рендериться поверх реалістичного фону, бо реальний попап напівпрозорий.
        </li>
      </ul>
      <p className="t-tertiary text-meta mt-4">
        Новий примітив у <code>shared/ui/</code> → поруч лягає <code>Foo.stories.tsx</code>.
      </p>
    </div>
  ),
};
