import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

// Adapted from shadcn/ui Native Select. Keep the browser arrow and a single
// select element so the existing flex layout and native keyboard behavior stay intact.
function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'min-w-0 rounded-md border border-input bg-background text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        'ui-native-select',
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
