'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Heading, Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { EnvelopeIcon } from '@heroicons/react/24/outline';
import { useQuery } from '@tanstack/react-query';
import { useState, type CSSProperties } from 'react';
import { LoadError } from '@/components/PageStates';
import { apiFetch } from '@/lib/api';
import { OutboxEmail, OutboxList, extractLinks, recipients } from '@/lib/dev-outbox';

/** The rendered email: tokens only; the iframe itself has no Astryx equivalent. */
const frameStyle: CSSProperties = {
  width: '100%',
  height: '60vh',
  border: 'var(--border-width) solid var(--color-border)',
  borderRadius: 'var(--radius-container)',
  backgroundColor: 'var(--color-background-card)',
};

function when(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

function EmailView({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['dev-outbox', id],
    queryFn: () => apiFetch(`/api/dev/outbox/${encodeURIComponent(id)}`, OutboxEmail),
  });
  if (query.isPending) return <Spinner aria-label="Loading email" />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  const email = query.data;
  const links = extractLinks(email);
  return (
    <VStack gap={6}>
      <VStack gap={3}>
        <Heading level={2}>{email.subject}</Heading>
        <MetadataList label={{ position: 'start', width: 64 }}>
          <MetadataListItem label="To">{recipients(email)}</MetadataListItem>
          <MetadataListItem label="Sent">{when(email.createdAt)}</MetadataListItem>
        </MetadataList>
      </VStack>
      {links.length > 0 ? (
        <VStack gap={2}>
          <Text weight="semibold">Links in this email</Text>
          <VStack gap={2}>
            {links.map((l) => (
              <Link key={l.url} href={l.appPath ?? l.url} isExternalLink={!l.appPath} isStandalone>
                {l.appPath ?? l.url}
              </Link>
            ))}
          </VStack>
        </VStack>
      ) : null}
      {email.html ? (
        <iframe
          title={`Email: ${email.subject}`}
          sandbox=""
          srcDoc={email.html}
          style={frameStyle}
        />
      ) : null}
      {email.text ? (
        <CodeBlock
          code={email.text}
          title="Plain text"
          hasLanguageLabel={false}
          isWrapped
          width="100%"
        />
      ) : null}
    </VStack>
  );
}

export function DevOutbox() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['dev-outbox'],
    queryFn: () => apiFetch('/api/dev/outbox', OutboxList),
  });
  const items = list.data?.items ?? [];
  const current = selected ?? items[0]?.id ?? null;

  return (
    <Layout
      padding={6}
      start={
        <LayoutPanel width={360} hasDivider label="Emails" role="navigation">
          <VStack gap={3} paddingInlineEnd={4}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={1}>Dev outbox</Heading>
              <Button
                label="Refresh"
                size="sm"
                variant="ghost"
                isLoading={list.isFetching}
                onClick={() => void list.refetch()}
              />
            </HStack>
            <Text type="supporting" color="secondary">
              Emails the local API would have sent. Development only.
            </Text>
            {list.isPending ? (
              <Spinner aria-label="Loading emails" />
            ) : list.isError ? (
              <LoadError error={list.error} onRetry={() => void list.refetch()} />
            ) : (
              <List edge="outset">
                {items.map((e) => (
                  <ListItem
                    key={e.id}
                    label={e.subject}
                    description={`${recipients(e)} · ${when(e.createdAt)}`}
                    isSelected={e.id === current}
                    onClick={() => setSelected(e.id)}
                  />
                ))}
              </List>
            )}
          </VStack>
        </LayoutPanel>
      }
      content={
        <LayoutContent label="Email">
          <VStack paddingInlineStart={6}>
            {current ? (
              <EmailView key={current} id={current} />
            ) : list.isSuccess ? (
              <Card padding={8}>
                <EmptyState
                  icon={<Icon icon={EnvelopeIcon} size="lg" color="secondary" />}
                  title="No emails yet"
                  description="Invites and password resets you trigger locally appear here."
                />
              </Card>
            ) : null}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
