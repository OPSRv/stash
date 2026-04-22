import type { Meta, StoryObj } from '@storybook/react-vite';
import { PanelHeader } from './PanelHeader';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';
import { useState } from 'react';
import { DownloadIcon, SearchIcon, TrashIcon } from './icons';

const meta = {
  title: 'Surfaces/PanelHeader',
  component: PanelHeader,
  tags: ['autodocs'],
  parameters: { surface: 'plain', layout: 'padded' },
} satisfies Meta<typeof PanelHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Caches: Story = {
  render: () => (
    <div className="pane rounded-xl overflow-hidden" style={{ width: 640 }}>
      <PanelHeader
        gradient={['#7B54E8', '#4A8BEA']}
        icon={<TrashIcon size={22} />}
        title="Caches"
        description="1,284 files • 3.7 GB reclaimable"
        trailing={
          <>
            <div className="t-primary font-semibold tabular-nums">3.7 GB</div>
            <Button size="sm" variant="soft">Refresh</Button>
          </>
        }
      />
    </div>
  ),
};

export const DiskHogsWithSegment: Story = {
  render: () => {
    const Demo = () => {
      const [sort, setSort] = useState<'size' | 'recent'>('size');
      return (
        <div className="pane rounded-xl overflow-hidden" style={{ width: 720 }}>
          <PanelHeader
            gradient={['#EA8B4A', '#EAD24A']}
            icon={<SearchIcon size={22} />}
            title="Disk hogs"
            description="Top directories over 500 MB on ~/Downloads"
            inlineRight={
              <SegmentedControl<'size' | 'recent'>
                size="sm"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'size', label: 'By size' },
                  { value: 'recent', label: 'Recent' },
                ]}
              />
            }
            trailing={
              <>
                <div className="t-primary font-semibold tabular-nums">24.1 GB</div>
                <Button size="sm" variant="soft" leadingIcon={<DownloadIcon size={12} />}>
                  Scan
                </Button>
              </>
            }
          />
        </div>
      );
    };
    return <Demo />;
  },
};
