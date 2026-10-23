import type { Meta, StoryObj } from '@storybook/react-vite';
import { statuses } from '../../lib/assets';
import { Status } from './Status';

const meta = {
  title: 'Library/Status',
  component: Status,
  args: { value: 'ready' },
  argTypes: { value: { control: 'select', options: Object.keys(statuses) } },
} satisfies Meta<typeof Status>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Processing: Story = { args: { value: 'processing' } };
export const Failed: Story = { args: { value: 'failed' } };
export const Retry: Story = { args: { value: 'retry' } };
export const All: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
      {Object.keys(statuses).map((value) => (
        <Status key={value} value={value} />
      ))}
    </div>
  ),
};
