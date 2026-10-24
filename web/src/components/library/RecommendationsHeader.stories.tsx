import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { assets } from '../../stories/fixtures';
import { RecommendationsHeader } from './RecommendationsHeader';

const meta = {
  title: 'Library/RecommendationsHeader',
  component: RecommendationsHeader,
  args: { source: assets[0], hashStatus: 'ready', onBack: fn() },
} satisfies Meta<typeof RecommendationsHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: '関連コンテンツ' }),
    ).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: '戻る' }));
    await expect(args.onBack).toHaveBeenCalledOnce();
  },
};
export const Pending: Story = { args: { hashStatus: 'pending' } };
export const Narrow: Story = {
  args: {
    hashStatus: 'pending',
    source: { ...assets[0], filename: `${'長い名前'.repeat(15)}.png` },
  },
  globals: { viewport: { value: 'narrow' } },
};
