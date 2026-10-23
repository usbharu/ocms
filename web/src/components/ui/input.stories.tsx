import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from './input';
import { Label } from './label';

const meta = {
  title: 'UI/Input',
  component: Input,
  args: { id: 'example-input', placeholder: 'カンマ区切りで追加' },
  render: (args) => (
    <div>
      <Label htmlFor="example-input">タグ</Label>
      <Input {...args} />
    </div>
  ),
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const Invalid: Story = { args: { 'aria-invalid': true } };
