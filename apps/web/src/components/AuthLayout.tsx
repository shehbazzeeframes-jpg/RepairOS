'use client';

import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Icon } from '@astryxdesign/core/Icon';
import { Section } from '@astryxdesign/core/Section';
import { Heading, Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { WrenchScrewdriverIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

export interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  /** Below the card, e.g. the link to the other auth screen. */
  footer?: ReactNode;
  /** Card column width: 400 for credential forms, 560 for longer forms. */
  width?: 400 | 560;
  children: ReactNode;
}

/** Centred card frame for signed-out and setup screens (from the Astryx login-card template). */
export function AuthLayout({ title, subtitle, footer, width = 400, children }: AuthLayoutProps) {
  return (
    // Muted ground so the card reads as raised (the login-card template paints the body colour here).
    <Section variant="muted" padding={0} minHeight="100dvh">
      <Center role="main" axis="both" padding={6} minHeight="100dvh">
        <VStack gap={5} hAlign="center" width="100%" maxWidth={width}>
          <VStack gap={2} hAlign="center">
            <Icon icon={WrenchScrewdriverIcon} size="lg" color="accent" />
            <Text type="body" weight="bold" size="lg">
              RepairOS
            </Text>
          </VStack>
          <Card padding={8} width="100%">
            <VStack gap={6} hAlign="stretch">
              <VStack gap={1} hAlign="center">
                <Heading level={1} justify="center">
                  {title}
                </Heading>
                {subtitle ? (
                  <Text color="secondary" justify="center">
                    {subtitle}
                  </Text>
                ) : null}
              </VStack>
              {children}
            </VStack>
          </Card>
          {footer}
        </VStack>
      </Center>
    </Section>
  );
}
