'use client';

/*
 * Marketing consent (spec §4.5, A17): three unticked switches; turning one on asks how consent was
 * given (required) and an optional note; turning one off records a withdrawal. US + SMS + verbal
 * shows the TCPA warning (a warning, never a block).
 */

import { HStack } from '@astryxdesign/core/HStack';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import {
  CONSENT_CHANNEL_LABELS,
  CONSENT_SOURCE_LABELS,
  TCPA_VERBAL_SMS_WARNING,
  effectiveConsentChanges,
  showTcpaWarning,
  type ConsentChangeInput,
  type ConsentChannel,
  type ConsentSource,
  type ConsentSummary,
  type CountryCode,
} from '@repairos/contracts';

export const CONSENT_CHANNELS: ConsentChannel[] = ['SMS', 'EMAIL', 'WHATSAPP'];
/** Sources a person can pick (IMPORT is system-only). */
export const GRANT_SOURCES: ConsentSource[] = [
  'IN_STORE_VERBAL',
  'IN_STORE_SIGNED',
  'ONLINE_FORM',
  'CUSTOMER_REQUEST',
];

export interface ConsentChoice {
  on: boolean;
  source: ConsentSource | '';
  note: string;
}
export type ConsentValue = Record<ConsentChannel, ConsentChoice>;

export function consentValueFrom(current: ConsentSummary | null): ConsentValue {
  const one = (c: ConsentChannel): ConsentChoice => ({
    on: !!current?.[c].granted,
    source: '',
    note: '',
  });
  return { SMS: one('SMS'), EMAIL: one('EMAIL'), WHATSAPP: one('WHATSAPP') };
}

/** Only effective changes (granting what isn't granted, withdrawing what is). */
export function consentChangesFrom(
  current: ConsentSummary | null,
  value: ConsentValue,
): ConsentChangeInput[] {
  const all = CONSENT_CHANNELS.map((channel) => {
    const v = value[channel];
    return v.on
      ? {
          channel,
          state: 'GRANTED' as const,
          ...(v.source ? { source: v.source } : {}),
          note: v.note.trim() || null,
        }
      : {
          channel,
          state: 'WITHDRAWN' as const,
          source: 'CUSTOMER_REQUEST' as const,
          note: v.note.trim() || null,
        };
  });
  const none = { granted: false, since: null, source: null, recordedByName: null };
  return effectiveConsentChanges(current ?? { SMS: none, EMAIL: none, WHATSAPP: none }, all);
}

/** Channels turned on without a source (the form blocks saving with "Choose how consent was given"). */
export function missingConsentSources(
  current: ConsentSummary | null,
  value: ConsentValue,
): ConsentChannel[] {
  return CONSENT_CHANNELS.filter((c) => value[c].on && !current?.[c].granted && !value[c].source);
}

export function ConsentEditor({
  value,
  onChange,
  current,
  country,
  showErrors,
}: {
  value: ConsentValue;
  onChange: (v: ConsentValue) => void;
  current: ConsentSummary | null;
  country: CountryCode;
  showErrors?: boolean;
}) {
  const missing = missingConsentSources(current, value);
  return (
    <VStack gap={3}>
      {CONSENT_CHANNELS.map((channel) => {
        const v = value[channel];
        const isNewGrant = v.on && !current?.[channel].granted;
        const set = (patch: Partial<ConsentChoice>) =>
          onChange({ ...value, [channel]: { ...v, ...patch } });
        return (
          <VStack key={channel} gap={2}>
            <Switch
              label={CONSENT_CHANNEL_LABELS[channel]}
              value={v.on}
              onChange={(on) => set({ on })}
            />
            {isNewGrant ? (
              <HStack gap={3} wrap="wrap" vAlign="start">
                <Selector
                  label="How was consent given?"
                  isRequired
                  value={v.source || undefined}
                  onChange={(s) => s && set({ source: s as ConsentSource })}
                  options={GRANT_SOURCES.filter((s) => s !== 'CUSTOMER_REQUEST').map((s) => ({
                    value: s,
                    label: CONSENT_SOURCE_LABELS[s],
                  }))}
                  description={
                    showTcpaWarning(country, {
                      channel,
                      state: 'GRANTED',
                      source: v.source || null,
                    })
                      ? TCPA_VERBAL_SMS_WARNING
                      : undefined
                  }
                  status={
                    showErrors && missing.includes(channel)
                      ? { type: 'error', message: 'Choose how consent was given' }
                      : showTcpaWarning(country, {
                            channel,
                            state: 'GRANTED',
                            source: v.source || null,
                          })
                        ? { type: 'warning' }
                        : undefined
                  }
                  width={260}
                />
                <TextInput
                  label="Note"
                  isOptional
                  value={v.note}
                  onChange={(note) => set({ note })}
                  width={260}
                />
              </HStack>
            ) : null}
          </VStack>
        );
      })}
    </VStack>
  );
}
