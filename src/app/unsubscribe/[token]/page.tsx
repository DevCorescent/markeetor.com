import { unsubscribeInfo } from '@/server/services/email';
import { UnsubscribeButton } from './unsubscribe-button';

export const metadata = { title: 'Unsubscribe' };

export default async function UnsubscribePage(props: PageProps<'/unsubscribe/[token]'>) {
  const { token } = await props.params;
  const info = await unsubscribeInfo(token).catch(() => null);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-7 text-center">
        <h1 className="text-xl">Email preferences</h1>
        {info ? (
          <>
            <p className="mt-2 text-[12.5px] text-muted">Stop receiving emails from <span className="text-fg">{info.sender}</span> at {info.email}.</p>
            <UnsubscribeButton token={token} />
          </>
        ) : (
          <p className="mt-2 text-[12.5px] text-muted">This link is invalid or has expired.</p>
        )}
      </div>
    </div>
  );
}
