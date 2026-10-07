'use client';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-fg text-inverse hover:bg-fg-2',
        secondary: 'bg-surface-3 text-fg border border-border-strong hover:bg-hover hover:border-faint',
        outline: 'border border-border-strong text-fg hover:bg-surface-3',
        ghost: 'text-muted hover:text-fg hover:bg-surface-3',
        danger: 'bg-danger-dim text-danger border border-danger/30 hover:bg-danger/20',
        link: 'text-fg underline-offset-4 hover:underline px-0 h-auto',
      },
      size: {
        xs: 'h-6 px-2 text-[11px]',
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-[13px]',
        lg: 'h-10 px-4 text-sm',
        icon: 'h-7 w-7',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button> & { loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, loading, children, disabled, type, ...props }, ref) {
  return (
    <button ref={ref} type={type ?? 'button'} className={cn(button({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading && <Loader2 className="animate-spin" />}
      {children}
    </button>
  );
});

export const buttonClass = button;
