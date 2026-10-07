import { cn } from '@/lib/cn';

export type BrandInfo = { productName: string; shortName: string; tagline: string; logoUrl: string | null; logoDarkUrl: string | null; showNameWithLogo: boolean };

/** Name written in the logo spot: the product name without its domain ("markeetor.com" → "markeetor"). */
export const logoText = (productName: string) => productName.replace(/\.[a-z]{2,}$/i, '');

/**
 * The product mark: uploaded logo (with an optional dark-theme variant) or a monogram tile.
 * Pure markup — theme switching is handled by CSS variants, so it renders correctly on first paint.
 */
export function BrandMark({ brand, size = 24, className }: { brand: BrandInfo; size?: number; className?: string }) {
  if (brand.logoUrl) {
    const img = 'w-auto max-w-[140px] object-contain object-left';
    return (
      <span className={cn('flex shrink-0 items-center', className)} style={{ height: size }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny versioned brand asset; next/image adds nothing here */}
        <img src={brand.logoUrl} alt={brand.productName} className={cn(img, brand.logoDarkUrl ? '[display:var(--only-light)]' : 'block')} style={{ height: size }} />
        {brand.logoDarkUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoDarkUrl} alt="" aria-hidden className={cn(img, '[display:var(--only-dark)]')} style={{ height: size }} />
        )}
      </span>
    );
  }
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-[5px] bg-fg font-bold tracking-tight text-inverse', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * (brand.shortName.length > 2 ? 0.38 : 0.46)) }}
      aria-hidden
    >
      {brand.shortName}
    </span>
  );
}
