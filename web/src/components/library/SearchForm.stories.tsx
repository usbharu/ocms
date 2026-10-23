import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SearchForm } from './SearchForm';

const meta = {
  title: 'Library/SearchForm',
  component: SearchForm,
  args: {
    query: '',
    mode: 'keyword',
    searching: false,
    onQueryChange: fn(),
    onModeChange: fn(),
    onSearch: fn(),
  },
  argTypes: {
    mode: { control: 'select', options: ['keyword', 'semantic', 'hybrid'] },
  },
  render: function Render(args) {
    const [query, setQuery] = useState(args.query);
    useEffect(() => setQuery(args.query), [args.query]);
    const [mode, setMode] = useState(args.mode);
    useEffect(() => setMode(args.mode), [args.mode]);
    return (
      <SearchForm
        {...args}
        query={query}
        mode={mode}
        onQueryChange={(query) => {
          args.onQueryChange(query);
          setQuery(query);
        }}
        onModeChange={(mode) => {
          args.onModeChange(mode);
          setMode(mode);
        }}
      />
    );
  },
} satisfies Meta<typeof SearchForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Keyword: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox'), '風景');
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: '検索方法' }),
      'hybrid',
    );
    await userEvent.click(canvas.getByRole('button', { name: '検索' }));
    await expect(args.onQueryChange).toHaveBeenLastCalledWith('風景');
    await expect(args.onModeChange).toHaveBeenCalledWith('hybrid');
    await expect(args.onSearch).toHaveBeenCalledOnce();
  },
};
export const Semantic: Story = {
  args: { mode: 'semantic', query: '山の風景' },
};
export const Hybrid: Story = { args: { mode: 'hybrid', query: '旅行' } };
export const Searching: Story = { args: { searching: true, query: '旅行' } };
export const Mobile: Story = { globals: { viewport: { value: 'mobile' } } };
