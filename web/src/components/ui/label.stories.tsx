import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from './input';
import { Label } from './label';

const meta = {
  title: 'UI/Label',
  component: Label,
  args: { children: 'タグ', htmlFor: 'labeled-input' },
  render: (args) => (
    <div>
      <Label {...args} />
      <Input id="labeled-input" />
    </div>
  ),
} satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
