import type { Meta, StoryObj } from '@storybook/react-vite';
import { Progress } from './progress';

const meta = {
  title: 'UI/Progress',
  component: Progress,
  args: { value: 45, 'aria-label': 'アップロード進捗' },
} satisfies Meta<typeof Progress>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Indeterminate: Story = { args: { value: null } };
export const Complete: Story = { args: { value: 100 } };
