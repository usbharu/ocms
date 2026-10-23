import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppHeader } from './AppHeader';

const meta = {
  title: 'Auth/AppHeader',
  component: AppHeader,
  args: { authenticated: true, onLogout: fn() },
} satisfies Meta<typeof AppHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Authenticated: Story = {};
export const Anonymous: Story = { args: { authenticated: false } };
