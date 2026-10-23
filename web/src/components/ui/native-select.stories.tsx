import type { Meta, StoryObj } from '@storybook/react-vite';
import { NativeSelect } from './native-select';

const meta = {
  title: 'UI/NativeSelect',
  component: NativeSelect,
  args: { 'aria-label': '検索方法', defaultValue: 'keyword' },
  render: (args) => (
    <NativeSelect {...args}>
      <option value="keyword">キーワード</option>
      <option value="semantic">意味</option>
      <option value="hybrid">キーワード＋意味</option>
    </NativeSelect>
  ),
} satisfies Meta<typeof NativeSelect>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
