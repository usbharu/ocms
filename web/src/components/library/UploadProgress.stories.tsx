import type { Meta, StoryObj } from '@storybook/react-vite';
import { UploadProgress } from './UploadProgress';

const meta = {
  title: 'Library/UploadProgress',
  component: UploadProgress,
  args: { value: 45 },
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100, step: 1 } },
  },
} satisfies Meta<typeof UploadProgress>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Uploading: Story = {};
export const Starting: Story = { args: { value: 0 } };
export const Complete: Story = { args: { value: 100 } };
