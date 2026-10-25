import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
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

export const Queue: Story = {
  args: {
    busy: false,
    tasks: [
      {
        id: 'one',
        file: new File(['one'], '完了.png', { type: 'image/png' }),
        state: 'completed',
        progress: 100,
      },
      {
        id: 'two',
        file: new File(['two'], '再送.pdf', { type: 'application/pdf' }),
        state: 'failed',
        progress: 50,
      },
    ],
    onRetry: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('1 / 2 件完了');
    await userEvent.click(
      canvas.getByRole('button', { name: '再送.pdfを再試行' }),
    );
    await expect(args.onRetry).toHaveBeenCalledWith(args.tasks?.[1]);
  },
};
