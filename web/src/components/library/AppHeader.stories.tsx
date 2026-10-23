import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { AppHeader } from './AppHeader';
import { UploadControl } from './UploadControl';

const meta = {
  title: 'Auth/AppHeader',
  component: AppHeader,
  args: {
    authenticated: true,
    onLogout: fn(),
    children: <UploadControl busy={false} onUpload={fn()} />,
  },
} satisfies Meta<typeof AppHeader>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Authenticated: Story = {};
export const Anonymous: Story = { args: { authenticated: false } };
