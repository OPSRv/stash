import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatCard } from './StatCard';
import { Sparkline } from '../../modules/system/Sparkline';
import { Badge } from './Badge';

const meta = {
  title: 'Surfaces/StatCard',
  component: StatCard,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'padded' },
} satisfies Meta<typeof StatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const netGlyph =
  'M5 12a14 14 0 0 1 14 0M3 8a20 20 0 0 1 18 0M7 16a8 8 0 0 1 10 0';

export const WiFi: Story = {
  render: () => (
    <div style={{ width: 320 }}>
      <StatCard
        gradient={['#8ec5ff', '#5561ff']}
        eyebrow={<>Wi-Fi <Badge tone="neutral" className="uppercase ml-1">primary</Badge></>}
        value="1.2 MB/s"
        hint="en0 · ssid Home"
        icon={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={netGlyph} />
          </svg>
        }
      />
    </div>
  ),
};

export const WithSparkline: Story = {
  render: () => {
    const rx = Array.from({ length: 24 }, (_, i) => Math.abs(Math.sin(i / 2)) * 80000);
    const tx = Array.from({ length: 24 }, (_, i) => Math.abs(Math.cos(i / 2)) * 40000);
    return (
      <div style={{ width: 320 }}>
        <StatCard
          gradient={['#7ef7a5', '#17b26a']}
          eyebrow="Ethernet"
          value="340 KB/s"
          hint="en1"
          footer={
            <div className="flex items-center gap-1">
              <Sparkline values={rx} color="#17b26a" width={90} height={20} />
              <Sparkline values={tx} color="#7ef7a5" width={90} height={20} />
            </div>
          }
        />
      </div>
    );
  },
};

export const Grid: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 300px)', gap: 12 }}>
      <StatCard gradient={['#ff8a5b', '#ff3a6f']} eyebrow="CPU" value="46%" hint="8 cores" />
      <StatCard gradient={['#ffd86b', '#ff914d']} eyebrow="RAM" value="62%" hint="pressure" />
      <StatCard gradient={['#5ee2c4', '#2aa3ff']} eyebrow="Disk" value="214 GB" hint="free of 1 TB" />
      <StatCard gradient={['#7ef7a5', '#17b26a']} eyebrow="Battery" value="84%" hint="cycle 112" />
    </div>
  ),
};
