import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { Button } from './button';

const meta = {
  title: 'UI/Button',
  component: Button,
  args: { children: '保存', onClick: fn() },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'default',
        'outline',
        'ghost',
        'link',
        'destructive',
        'secondary',
      ],
    },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Outline: Story = { args: { variant: 'outline' } };
export const Disabled: Story = { args: { disabled: true } };
export const Link: Story = {
  render: () => (
    <Button asChild variant="outline">
      <a href="#example">元ファイルを開く</a>
    </Button>
  ),
};
