import type { Preview } from '@storybook/react-vite';
import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { mediaHandlers } from '../src/stories/fixtures';
import '../src/style.css';

const preview: Preview = {
  tags: ['autodocs'],
  loaders: [
    mswLoader(async () => {
      const worker = setupWorker();
      await worker.start({
        quiet: true,
        onUnhandledFrame: 'bypass',
      });
      return worker;
    }),
  ],
  parameters: {
    layout: 'fullscreen',
    msw: { handlers: mediaHandlers },
    // Report existing accessibility findings in the panel without blocking interaction tests.
    a11y: { test: 'todo' },
    viewport: {
      options: {
        desktop: { name: 'PC', styles: { width: '1440px', height: '1000px' } },
        mobile: {
          name: 'モバイル',
          styles: { width: '390px', height: '844px' },
        },
        narrow: { name: '最小幅', styles: { width: '320px', height: '740px' } },
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="shell">
        <main>
          <Story />
        </main>
      </div>
    ),
  ],
};

export default preview;
