import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { UploadControl } from './UploadControl';

const meta = {
  title: 'Library/UploadControl',
  component: UploadControl,
  args: { busy: false, onUpload: fn() },
} satisfies Meta<typeof UploadControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    const file = new File(['synthetic image'], 'sample.png', {
      type: 'image/png',
    });
    await userEvent.upload(
      within(canvasElement).getByLabelText('アップロードするファイル'),
      file,
    );
    await expect(args.onUpload).toHaveBeenCalledWith([file]);
  },
};
export const Busy: Story = { args: { busy: true } };

export const Multiple: Story = {
  play: async ({ canvasElement, args }) => {
    const files = [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.pdf', { type: 'application/pdf' }),
    ];
    await userEvent.upload(
      within(canvasElement).getByLabelText('アップロードするファイル'),
      files,
    );
    await expect(args.onUpload).toHaveBeenCalledWith(files);
  },
};
