import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { assets } from '../../stories/fixtures';
import { AssetList } from './AssetList';

const meta = {
  title: 'Library/AssetList',
  component: AssetList,
  args: {
    assets,
    view: 'list',
    kind: 'all',
    searching: false,
    isResult: false,
    uploading: false,
    currentPage: 1,
    pageCount: 1,
    resultCount: assets.length,
    onFavorite: fn(),
    onSelect: fn(),
    onReset: fn(),
    onUpload: fn(),
    onPageChange: fn(),
  },
  argTypes: {
    view: { control: 'select', options: ['list', 'grid', 'detailed-grid'] },
  },
  render: function Render(args) {
    const [selectedId, setSelectedId] = useState(args.selectedId);
    useEffect(() => setSelectedId(args.selectedId), [args.selectedId]);
    const [currentPage, setCurrentPage] = useState(args.currentPage);
    useEffect(() => setCurrentPage(args.currentPage), [args.currentPage]);
    return (
      <AssetList
        {...args}
        selectedId={selectedId}
        currentPage={currentPage}
        onSelect={(asset) => {
          args.onSelect(asset);
          setSelectedId(asset.asset_id);
        }}
        onPageChange={(page) => {
          args.onPageChange(page);
          setCurrentPage(page);
        }}
      />
    );
  },
} satisfies Meta<typeof AssetList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: assets[0].filename }),
    );
    await expect(args.onSelect).toHaveBeenCalledWith(assets[0]);
    await expect(
      canvas.getByRole('button', { name: assets[0].filename }),
    ).toHaveAttribute('aria-pressed', 'true');
  },
};
export const Grid: Story = { args: { view: 'grid' } };
export const DetailedGrid: Story = { args: { view: 'detailed-grid' } };
export const Mobile: Story = { globals: { viewport: { value: 'mobile' } } };
export const NarrowGrid: Story = {
  args: { view: 'grid' },
  globals: { viewport: { value: 'narrow' } },
};
export const Empty: Story = { args: { assets: [], resultCount: 0 } };
export const NoMatches: Story = {
  args: { assets: [], resultCount: 0, isResult: true },
};
export const EmptyKind: Story = {
  args: { assets: [], resultCount: 0, kind: 'audio' },
};
export const Loading: Story = {
  args: { assets: [], resultCount: 0, searching: true },
};
export const Refreshing: Story = { args: { searching: true } };
export const Pagination: Story = {
  args: { pageCount: 3, resultCount: 52 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '前へ' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: '次へ' }));
    await expect(args.onPageChange).toHaveBeenCalledWith(2);
    await expect(canvas.getByText('2 / 3 ページ')).toBeVisible();
  },
};
export const LastPage: Story = {
  args: { currentPage: 3, pageCount: 3, resultCount: 52 },
};
export const LongFilename: Story = {
  args: {
    assets: [
      { ...assets[0], filename: `${'とても長いファイル名'.repeat(12)}.png` },
    ],
  },
};

export const Favorites: Story = {
  args: {
    assets: assets.map((asset, index) => ({
      ...asset,
      is_favorite: index === 0,
    })),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', {
      name: `${assets[0].filename}：お気に入りを解除`,
    });
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(button);
    await expect(args.onFavorite).toHaveBeenCalledWith(args.assets[0]);
    await expect(args.onSelect).not.toHaveBeenCalled();
  },
};
export const EmptyFavorites: Story = {
  args: { assets: [], favorites: true, resultCount: 0 },
};
export const FavoriteSaving: Story = {
  args: { favoriteBusy: new Set([assets[0].asset_id]) },
};

export const Recommendations: Story = {
  args: {
    view: 'detailed-grid',
    recommendations: assets.map((asset, i) => ({
      ...asset,
      score: 92.125 - i * 20,
      common_tags: ['旅行', '風景', '画像', '記録'],
      common_characters: ['キャラクターA'],
      perceptual: 'visual',
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('評価 92.1')).toBeVisible();
    await expect(
      canvas.getAllByText('共通タグ：旅行 · 風景 · 画像 · ほか1件')[0],
    ).toBeVisible();
    await expect(
      canvas.getAllByText('共通キャラクター：キャラクターA')[0],
    ).toBeVisible();
  },
};
