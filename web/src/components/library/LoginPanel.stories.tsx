import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { LoginPanel } from './LoginPanel';

const meta = {
  title: 'Auth/LoginPanel',
  component: LoginPanel,
  args: { development: false, onDevLogin: fn() },
} satisfies Meta<typeof LoginPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SSO: Story = {};
export const Development: Story = {
  args: { development: true },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'alice でログイン' }),
    );
    await expect(args.onDevLogin).toHaveBeenCalledWith('alice');
  },
};
