import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, within } from 'storybook/test';
import type { Asset, AssetChanges } from '../../lib/assets';
import { assets } from '../../stories/fixtures';
import { AssetMetadataEditor } from './AssetMetadataEditor';

const meta = {
  title: 'Library/AssetMetadataEditor',
  component: AssetMetadataEditor,
  args: {
    onSearchTag: fn(),
    asset: assets[0],
    onSave: fn<(changes: AssetChanges) => Promise<Asset>>(async (changes) => ({
      ...assets[0],
      ...changes,
    })),
  },
} satisfies Meta<typeof AssetMetadataEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SearchTag: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const tag = canvas.getByRole('button', { name: 'タグ「旅行」で検索' });
    await userEvent.click(tag);
    await expect(args.onSearchTag).toHaveBeenCalledWith('旅行');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await expect(args.onSearchTag).toHaveBeenCalledTimes(3);
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const Edit: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('名前を変更'));
    const name = canvas.getByRole('textbox', { name: 'ファイル名' });
    await userEvent.clear(name);
    await userEvent.type(name, '変更.png{Enter}');
    await expect(args.onSave).toHaveBeenCalledWith({ filename: '変更.png' });
    await expect(name).toBeEnabled();
    await userEvent.click(
      canvas.getByRole('button', { name: 'タグ「旅行」を削除' }),
    );
    await expect(args.onSave).toHaveBeenCalledWith({ tags: ['風景'] });
  },
};

export const EmptyAndDuplicate: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: 'タグ' });
    await userEvent.type(input, '   {Enter}');
    await expect(args.onSave).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '旅行{Enter}');
    await expect(canvas.getByRole('alert')).toHaveTextContent('追加済み');
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};

export const Composing: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('名前を変更'));
    const name = canvas.getByRole('textbox', { name: 'ファイル名' });
    await userEvent.clear(name);
    await userEvent.type(name, '変換中');
    fireEvent.compositionStart(name);
    await userEvent.keyboard('{Enter}');
    await expect(args.onSave).not.toHaveBeenCalled();
    fireEvent.compositionEnd(name);
    await userEvent.keyboard('{Escape}');
    await expect(name).toHaveValue(assets[0].filename);
  },
};

export const Saving: Story = {
  args: {
    onSave: fn<(changes: AssetChanges) => Promise<Asset>>(
      () => new Promise(() => {}),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('名前を変更'));
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'タグ' }),
      '新規{Enter}',
    );
    await expect(canvas.getByRole('status')).toHaveTextContent('保存中');
    await expect(
      canvas.getByRole('textbox', { name: 'ファイル名' }),
    ).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: 'タグ' })).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: 'タグ「旅行」で検索' }),
    ).toBeDisabled();
  },
};

export const Retry: Story = {
  play: async ({ canvasElement, args }) => {
    args.onSave.mockReset();
    args.onSave.mockRejectedValueOnce(new Error('unavailable'));
    args.onSave.mockImplementationOnce(async (changes) => ({
      ...assets[0],
      ...changes,
    }));
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: 'タグ' });
    await userEvent.type(input, '新規{Enter}');
    await expect(canvas.getByRole('alert')).toHaveTextContent(
      '保存できませんでした',
    );
    await expect(input).toHaveValue('新規');
    await userEvent.click(canvas.getByRole('button', { name: '保存を再試行' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('保存しました');
    await expect(args.onSave).toHaveBeenCalledTimes(2);
  },
};

export const NoTags: Story = { args: { asset: { ...assets[0], tags: [] } } };
export const TagLimit: Story = {
  args: {
    asset: {
      ...assets[0],
      tags: Array.from({ length: 512 }, (_, i) => `tag-${i}`),
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole('textbox', { name: 'タグ' }),
      '新規{Enter}',
    );
    await expect(canvas.getByRole('alert')).toHaveTextContent('512件');
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};
