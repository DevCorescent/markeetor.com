'use client';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/overlay';
import { PageHeader } from '@/components/ui/page';
import { useUrlState } from '@/lib/hooks';
import { BatchList, HistoryList } from './batch-list';
import { DistributeWizard } from './distribute-wizard';
import { DistributionAnalytics } from './distribution-analytics';
import { RulesPanel } from './rules';
import { DistributionTracker } from './tracker';

export function DistributionHub({ perms }: { perms: { create: boolean; rules: boolean } }) {
  const [s, set] = useUrlState({ tab: perms.create ? 'new' : 'analytics' });
  return (
    <>
      <PageHeader
        title="Lead distribution"
        description="Pick leads, choose clients, decide how to split, review and send — then track where every lead went and how clients performed. Every allocation is transactional, reversible and audited."
      />
      <Tabs value={s.tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList className="mb-5">
          {perms.create && <TabsTrigger value="new">Distribute</TabsTrigger>}
          <TabsTrigger value="tracker">Lead tracker</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="batches">Batches</TabsTrigger>
          {perms.rules && <TabsTrigger value="rules">Automated rules</TabsTrigger>}
          <TabsTrigger value="history">Assignment log</TabsTrigger>
        </TabsList>
      </Tabs>
      {s.tab === 'new' && perms.create && <DistributeWizard />}
      {s.tab === 'tracker' && <DistributionTracker />}
      {s.tab === 'analytics' && <DistributionAnalytics onDistribute={() => set({ tab: perms.create ? 'new' : 'analytics' })} />}
      {s.tab === 'batches' && <BatchList />}
      {s.tab === 'rules' && perms.rules && <RulesPanel />}
      {s.tab === 'history' && <HistoryList />}
    </>
  );
}
