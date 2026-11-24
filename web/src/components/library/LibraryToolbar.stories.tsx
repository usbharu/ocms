import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { LibraryToolbar } from './LibraryToolbar';

const meta = {
  title: 'Library/LibraryToolbar',
  component: LibraryToolbar,
  args: {
    kind: 'all',
    view: 'list',
    sort: 'created_desc',
    favorites: false,
    onKindChange: fn(),
    onViewChange: fn(),
    onSortChange: fn(),
    onRefresh: fn(),
  },
  render: function Render(args) {
    const [kind, setKind] = useState(args.kind);
    useEffect(() => setKind(args.kind), [args.kind]);
    const [view, setView] = useState(args.view);
    useEffect(() => setView(args.view), [args.view]);
    const [sort, setSort] = useState(args.sort);
    useEffect(() => setSort(args.sort), [args.sort]);
    return (
      <LibraryToolbar
        {...args}
        kind={kind}
        view={view}
        sort={sort}
        onKindChange={(kind) => {
          args.onKindChange(kind);
          setKind(kind);
        }}
        onViewChange={(view) => {
          args.onViewChange(view);
          setView(view);
        }}
        onSortChange={(sort) => {
          args.onSortChange?.(sort);
          setSort(sort);
        }}
      />
    );
  },
} satisfies Meta<typeof LibraryToolbar>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '画像' }));
    await expect(args.onKindChange).toHaveBeenCalledWith('image');
    await expect(canvas.getByRole('button', { name: '画像' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: '並べ替え' }),
      'updated_desc',
    );
    await expect(args.onSortChange).toHaveBeenCalledWith('updated_desc');
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: '表示方法' }),
      'grid',
    );
    await expect(args.onViewChange).toHaveBeenCalledWith('grid');
    await userEvent.click(canvas.getByRole('button', { name: '更新' }));
    await expect(args.onRefresh).toHaveBeenCalledOnce();
  },
};
export const Mobile: Story = { globals: { viewport: { value: 'mobile' } } };
