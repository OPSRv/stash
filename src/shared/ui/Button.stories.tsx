import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';
import { CheckIcon, DownloadIcon, ExternalIcon, TrashIcon } from './icons';

const meta = {
  title: 'Primitives/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'inline-radio', options: ['solid', 'soft', 'ghost', 'outline'] },
    tone: { control: 'inline-radio', options: ['neutral', 'accent', 'success', 'warning', 'danger'] },
    size: { control: 'inline-radio', options: ['xs', 'sm', 'md', 'lg'] },
    shape: { control: 'inline-radio', options: ['default', 'square', 'pill'] },
    loading: { control: 'boolean' },
    fullWidth: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
  args: {
    children: 'Save changes',
    variant: 'solid',
    tone: 'accent',
    size: 'md',
    shape: 'default',
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllTones: Story = {
  parameters: { layout: 'padded' },
  render: (args) => (
    <div className="sb-col">
      {(['solid', 'soft', 'ghost', 'outline'] as const).map((variant) => (
        <div key={variant}>
          <div className="sb-label">{variant}</div>
          <div className="sb-row">
            {(['neutral', 'accent', 'success', 'warning', 'danger'] as const).map((tone) => (
              <Button key={tone} {...args} variant={variant} tone={tone}>
                {tone}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="sb-row">
      {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
        <Button key={size} {...args} size={size}>
          Size {size}
        </Button>
      ))}
    </div>
  ),
};

export const WithIcons: Story = {
  render: (args) => (
    <div className="sb-row">
      <Button {...args} leadingIcon={<DownloadIcon size={14} />}>Download</Button>
      <Button {...args} tone="neutral" variant="soft" trailingIcon={<ExternalIcon size={12} />}>
        Open link
      </Button>
      <Button {...args} tone="success" variant="solid" leadingIcon={<CheckIcon size={14} />}>
        Approve
      </Button>
      <Button {...args} tone="danger" variant="soft" leadingIcon={<TrashIcon size={14} />}>
        Delete
      </Button>
    </div>
  ),
};

export const Shapes: Story = {
  render: (args) => (
    <div className="sb-row">
      <Button {...args}>Default</Button>
      <Button {...args} shape="pill">Pill</Button>
      <Button {...args} shape="square" aria-label="square"><CheckIcon size={14} /></Button>
    </div>
  ),
};

export const Loading: Story = {
  args: { loading: true, children: 'Saving…' },
};

export const Disabled: Story = {
  args: { disabled: true, children: 'Not available' },
};
