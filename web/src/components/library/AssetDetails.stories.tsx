import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { assets, jobs, renditions } from '../../stories/fixtures';
import { AssetDetails } from './AssetDetails';

const meta = {
  title: 'Library/AssetDetails',
  component: AssetDetails,
  args: {
    selected: assets[0],
    renditions,
    jobs,
    searching: false,
    notice: '',
    onClose: fn(),
    onSaveMetadata: fn(async (changes) => ({ ...assets[0], ...changes })),
    onCompare: fn(),
    onReprocess: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof AssetDetails>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Image: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const tags = canvas.getByRole('textbox', { name: 'タグ' });
    await userEvent.type(tags, '  新しいタグ  ');
    await userEvent.click(canvas.getByRole('button', { name: '追加' }));
    await expect(args.onSaveMetadata).toHaveBeenCalledWith({
      tags: ['旅行', '風景', '新しいタグ'],
    });
    await expect(
      canvas.getByRole('button', { name: 'タグ「新しいタグ」を削除' }),
    ).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: '類似ファイル' }));
    await expect(args.onCompare).toHaveBeenCalledWith('perceptual');
    await userEvent.click(
      canvas.getByRole('button', { name: '完全一致ファイル' }),
    );
    await expect(args.onCompare).toHaveBeenCalledWith('exact_duplicate');
  },
};
export const Video: Story = { args: { selected: assets[1], renditions: [] } };
export const Audio: Story = { args: { selected: assets[2], renditions: [] } };
export const PDFMatch: Story = {
  args: { selected: { ...assets[3], status: 'ready' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('img', { name: 'PDF 2ページ目' }),
    ).toHaveAttribute(
      'src',
      '/api/v1/assets/story-pdf/renditions/page-2/content',
    );
    await expect(
      canvas.getByRole('link', { name: '元ファイルを開く' }),
    ).toHaveAttribute('href', '/api/v1/assets/story-pdf/content#page=2');
  },
};
export const ProcessingPDF: Story = {
  args: {
    selected: { ...assets[3], status: 'processing' },
    renditions: [],
    jobs: [],
  },
};
export const Failed: Story = {
  args: {
    selected: assets[3],
    renditions: [],
    jobs: [
      {
        ...jobs[0],
        status: 'failed',
        attempts: 4,
        error_code: 'processing_failed',
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByText('処理状況', { exact: false, selector: 'summary' }),
    );
    await userEvent.click(canvas.getByRole('button', { name: '再試行' }));
    await expect(args.onReprocess).toHaveBeenCalledOnce();
  },
};
export const Saved: Story = { args: { notice: '処理をリクエストしました' } };
export const Mobile: Story = { globals: { viewport: { value: 'mobile' } } };
