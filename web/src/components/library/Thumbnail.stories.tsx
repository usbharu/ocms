import type { Meta, StoryObj } from '@storybook/react-vite';
import { HttpResponse, http } from 'msw';
import { assets } from '../../stories/fixtures';
import { Thumbnail } from './Thumbnail';

const meta = {
  title: 'Library/Thumbnail',
  component: Thumbnail,
  args: { asset: assets[0] },
} satisfies Meta<typeof Thumbnail>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Image: Story = {};
export const Audio: Story = { args: { asset: assets[2] } };
export const PDFPage: Story = { args: { asset: assets[3] } };
export const Unavailable: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          '/api/v1/assets/:id/preview',
          () => new HttpResponse(null, { status: 404 }),
        ),
      ],
    },
  },
};
export const Processing: Story = {
  args: { asset: { ...assets[0], status: 'processing' } },
  parameters: Unavailable.parameters,
};
