export function AuthCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-strong bg-surface/90 p-7 shadow-2xl shadow-shade backdrop-blur">
      <h1 className="text-[22px] leading-tight font-[560] tracking-[-0.03em]">{title}</h1>
      {description && <p className="mt-1.5 text-[12.5px] text-muted">{description}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}
