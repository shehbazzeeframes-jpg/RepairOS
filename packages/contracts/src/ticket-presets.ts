import { z } from 'zod';
import type { DeviceTypeValue } from './device-catalogue';

/**
 * Built-in check-in data (Sprint 2 story §5.1, decision A18): common issues, pre-repair checklist items,
 * accessories and cancel reasons. Fixed in Sprint 2 (editing comes with the Sprint 3 price list).
 * Codes are stored; labels are snapshotted on the ticket for issues and resolved from here for the rest.
 */

// ---------- Issues ----------

export const ISSUE_CODES = [
  'SCREEN_CRACKED',
  'DISPLAY_TOUCH',
  'BATTERY',
  'CHARGING_PORT',
  'BACK_GLASS',
  'CAMERA',
  'SPEAKER_MIC',
  'WATER_DAMAGE',
  'NO_POWER',
  'SOFTWARE',
  'DATA_RECOVERY',
  'BUTTONS',
  'KEYBOARD',
  'TRACKPAD',
  'HINGE',
  'SLOW_VIRUS',
  'OS_INSTALL',
  'FAN_OVERHEATING',
  'HDMI_PORT',
  'DISC_DRIVE',
  'CONTROLLER_DRIFT',
  'OVERHEATING',
  'STRAP_BAND',
] as const;
export const IssueCode = z.enum(ISSUE_CODES);
export type IssueCode = z.infer<typeof IssueCode>;

export const ISSUE_LABELS: Record<IssueCode, string> = {
  SCREEN_CRACKED: 'Screen cracked',
  DISPLAY_TOUCH: 'Display/touch not working',
  BATTERY: 'Battery',
  CHARGING_PORT: 'Charging port',
  BACK_GLASS: 'Back glass',
  CAMERA: 'Camera',
  SPEAKER_MIC: 'Speaker/mic',
  WATER_DAMAGE: 'Water damage',
  NO_POWER: "Won't turn on",
  SOFTWARE: 'Software/updates',
  DATA_RECOVERY: 'Data recovery',
  BUTTONS: 'Buttons',
  KEYBOARD: 'Keyboard',
  TRACKPAD: 'Trackpad',
  HINGE: 'Hinge',
  SLOW_VIRUS: 'Slow/virus',
  OS_INSTALL: 'OS install',
  FAN_OVERHEATING: 'Fan/overheating',
  HDMI_PORT: 'HDMI port',
  DISC_DRIVE: 'Disc drive',
  CONTROLLER_DRIFT: 'Controller drift',
  OVERHEATING: 'Overheating',
  STRAP_BAND: 'Strap/band',
};

const PHONE_ISSUES: readonly IssueCode[] = [
  'SCREEN_CRACKED', 'DISPLAY_TOUCH', 'BATTERY', 'CHARGING_PORT', 'BACK_GLASS', 'CAMERA', 'SPEAKER_MIC',
  'WATER_DAMAGE', 'NO_POWER', 'SOFTWARE', 'DATA_RECOVERY', 'BUTTONS',
];
const COMPUTER_BASE: readonly IssueCode[] = [
  'SCREEN_CRACKED', 'DISPLAY_TOUCH', 'BATTERY', 'CHARGING_PORT', 'SPEAKER_MIC', 'WATER_DAMAGE', 'NO_POWER',
  'SOFTWARE', 'DATA_RECOVERY',
];

/** Issue chips per device type, in display order. Any `IssueCode` is accepted on any type (chips are a shortcut). */
export const ISSUE_PRESETS_BY_DEVICE_TYPE: Record<DeviceTypeValue, readonly IssueCode[]> = {
  PHONE: PHONE_ISSUES,
  TABLET: PHONE_ISSUES,
  LAPTOP: [...COMPUTER_BASE, 'KEYBOARD', 'TRACKPAD', 'HINGE', 'SLOW_VIRUS', 'OS_INSTALL', 'FAN_OVERHEATING'],
  DESKTOP: [
    'DISPLAY_TOUCH', 'NO_POWER', 'SOFTWARE', 'DATA_RECOVERY', 'WATER_DAMAGE', 'KEYBOARD', 'SLOW_VIRUS', 'OS_INSTALL',
    'FAN_OVERHEATING',
  ],
  CONSOLE: ['NO_POWER', 'HDMI_PORT', 'DISC_DRIVE', 'CONTROLLER_DRIFT', 'OVERHEATING', 'CHARGING_PORT', 'WATER_DAMAGE', 'SOFTWARE', 'BUTTONS'],
  WATCH: ['SCREEN_CRACKED', 'DISPLAY_TOUCH', 'BATTERY', 'CHARGING_PORT', 'BUTTONS', 'WATER_DAMAGE', 'NO_POWER', 'SOFTWARE', 'STRAP_BAND'],
  OTHER: ['NO_POWER', 'SCREEN_CRACKED', 'BATTERY', 'CHARGING_PORT', 'BUTTONS', 'WATER_DAMAGE', 'SOFTWARE'],
};

export const MAX_TICKET_ISSUES = 10;

/**
 * One issue on a ticket input: a preset `{ code }` (label filled from `ISSUE_LABELS`) or a custom `{ label }`
 * (1–80 chars). Stored as `{ code?: IssueCode, label: string }`.
 */
export const TicketIssueInput = z.union([
  z.object({ code: IssueCode }).strict(),
  z.object({ label: z.string().trim().min(1).max(80) }).strict(),
]);
export type TicketIssueInput = z.infer<typeof TicketIssueInput>;

/** Stored/returned issue. */
export const TicketIssue = z.object({ code: IssueCode.nullable(), label: z.string() });
export type TicketIssue = z.infer<typeof TicketIssue>;

/** Input → stored issue (label snapshot), de-duplicated by code / case-insensitive label. */
export function toTicketIssues(input: readonly TicketIssueInput[]): TicketIssue[] {
  const seen = new Set<string>();
  const out: TicketIssue[] = [];
  for (const i of input) {
    const issue: TicketIssue = 'code' in i ? { code: i.code, label: ISSUE_LABELS[i.code] } : { code: null, label: i.label };
    const key = issue.code ?? `label:${issue.label.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

// ---------- Condition checklist ----------

export const CHECKLIST_ITEM_KEYS = [
  'POWERS_ON',
  'SCREEN',
  'FRONT_CAMERA',
  'REAR_CAMERA',
  'BUTTONS',
  'BIOMETRICS',
  'SPEAKERS',
  'MICROPHONE',
  'CHARGING',
  'WIRELESS',
  'LIQUID',
  'KEYBOARD',
  'TRACKPAD',
  'PORTS',
  'BATTERY',
  'WEBCAM',
  'DISPLAY_OUTPUT',
  'DISC_DRIVE',
  'CONTROLLERS',
  'STRAP',
] as const;
export const ChecklistItemKey = z.enum(CHECKLIST_ITEM_KEYS);
export type ChecklistItemKey = z.infer<typeof ChecklistItemKey>;

export const ChecklistResult = z.enum(['PASS', 'FAIL', 'UNTESTED']);
export type ChecklistResult = z.infer<typeof ChecklistResult>;
export const CHECKLIST_RESULT_LABELS: Record<ChecklistResult, string> = { PASS: 'Pass', FAIL: 'Fail', UNTESTED: 'Untested' };
/** Keyboard shortcuts in check-in (TK1.5). */
export const CHECKLIST_RESULT_KEYS: Record<'p' | 'f' | 'u', ChecklistResult> = { p: 'PASS', f: 'FAIL', u: 'UNTESTED' };

export interface ChecklistItem {
  key: ChecklistItemKey;
  label: string;
}

const item = (key: ChecklistItemKey, label: string): ChecklistItem => ({ key, label });

const GENERIC_CHECKLIST: readonly ChecklistItem[] = [
  item('POWERS_ON', 'Powers on'),
  item('SCREEN', 'Screen'),
  item('BUTTONS', 'Buttons'),
  item('CHARGING', 'Charging'),
  item('LIQUID', 'Liquid damage'),
];

const PHONE_CHECKLIST: readonly ChecklistItem[] = [
  item('POWERS_ON', 'Powers on'),
  item('SCREEN', 'Screen/touch'),
  item('FRONT_CAMERA', 'Front camera'),
  item('REAR_CAMERA', 'Rear camera'),
  item('BUTTONS', 'Buttons'),
  item('BIOMETRICS', 'Face ID / Touch ID'),
  item('SPEAKERS', 'Speakers'),
  item('MICROPHONE', 'Microphone'),
  item('CHARGING', 'Charging'),
  item('WIRELESS', 'Wi-Fi/Bluetooth'),
  item('LIQUID', 'Liquid indicators'),
];

const COMPUTER_CHECKLIST: readonly ChecklistItem[] = [
  item('POWERS_ON', 'Powers on'),
  item('SCREEN', 'Screen'),
  item('KEYBOARD', 'Keyboard'),
  item('TRACKPAD', 'Trackpad'),
  item('PORTS', 'Ports'),
  item('BATTERY', 'Battery'),
  item('WEBCAM', 'Webcam'),
  item('SPEAKERS', 'Speakers'),
  item('CHARGING', 'Charging'),
  item('LIQUID', 'Liquid'),
];

/** Pre-repair checklist items per device type, in display order (TK1.5). */
export const CHECKLIST_ITEMS_BY_DEVICE_TYPE: Record<DeviceTypeValue, readonly ChecklistItem[]> = {
  PHONE: PHONE_CHECKLIST,
  TABLET: PHONE_CHECKLIST,
  LAPTOP: COMPUTER_CHECKLIST,
  DESKTOP: COMPUTER_CHECKLIST,
  CONSOLE: [
    item('POWERS_ON', 'Powers on'),
    item('DISPLAY_OUTPUT', 'Display output (HDMI)'),
    item('DISC_DRIVE', 'Disc drive'),
    item('CONTROLLERS', 'Controllers'),
    item('PORTS', 'Ports'),
    item('LIQUID', 'Liquid damage'),
  ],
  WATCH: [
    item('POWERS_ON', 'Powers on'),
    item('SCREEN', 'Screen/touch'),
    item('BUTTONS', 'Buttons/crown'),
    item('CHARGING', 'Charging'),
    item('STRAP', 'Strap'),
    item('LIQUID', 'Liquid damage'),
  ],
  OTHER: GENERIC_CHECKLIST,
};

/**
 * Checklist on input: `{ [itemKey]: result }`, partial (missing = UNTESTED). The API rejects keys not in the
 * device type's list (400 VALIDATION_FAILED at `["checklist", key]`); use `checklistKeyProblems`.
 */
export const ChecklistInput = z.record(ChecklistItemKey, ChecklistResult);
export type ChecklistInput = z.infer<typeof ChecklistInput>;

/** Keys of `checklist` that are not items of `type`. */
export function checklistKeyProblems(type: DeviceTypeValue, checklist: Partial<Record<string, unknown>>): string[] {
  const allowed = new Set<string>(CHECKLIST_ITEMS_BY_DEVICE_TYPE[type].map((i) => i.key));
  return Object.keys(checklist).filter((k) => !allowed.has(k));
}

/** Full checklist for a type (every item present, UNTESTED by default) — what reads return. */
export function completeChecklist(
  type: DeviceTypeValue,
  checklist: Partial<Record<ChecklistItemKey, ChecklistResult>> = {},
): Partial<Record<ChecklistItemKey, ChecklistResult>> {
  const out: Partial<Record<ChecklistItemKey, ChecklistResult>> = {};
  for (const i of CHECKLIST_ITEMS_BY_DEVICE_TYPE[type]) out[i.key] = checklist[i.key] ?? 'UNTESTED';
  return out;
}

// ---------- Accessories ----------

export const ACCESSORY_CODES = ['SIM_CARD', 'SIM_TRAY', 'MEMORY_CARD', 'CASE', 'CHARGER', 'CABLE', 'STYLUS', 'BOX', 'OTHER'] as const;
export const AccessoryCode = z.enum(ACCESSORY_CODES);
export type AccessoryCode = z.infer<typeof AccessoryCode>;
export const ACCESSORY_LABELS: Record<AccessoryCode, string> = {
  SIM_CARD: 'SIM card',
  SIM_TRAY: 'SIM tray',
  MEMORY_CARD: 'Memory card',
  CASE: 'Case',
  CHARGER: 'Charger',
  CABLE: 'Cable',
  STYLUS: 'Stylus',
  BOX: 'Box',
  OTHER: 'Other',
};
/** Empty accessories label. */
export const NO_ACCESSORIES_LABEL = 'Nothing left with device';

/** "SIM card, Case, Other: Pen drive" (for the Collect confirm dialog). */
export function accessoriesSummary(codes: readonly AccessoryCode[], other?: string | null): string {
  if (codes.length === 0) return NO_ACCESSORIES_LABEL;
  return codes.map((c) => (c === 'OTHER' && other ? `Other: ${other}` : ACCESSORY_LABELS[c])).join(', ');
}

// ---------- Cancel reasons ----------

export const CANCEL_REASONS = ['CUSTOMER_DECLINED', 'CUSTOMER_TOOK_BACK', 'CREATED_BY_MISTAKE', 'DUPLICATE', 'OTHER'] as const;
export const CancelReason = z.enum(CANCEL_REASONS);
export type CancelReason = z.infer<typeof CancelReason>;
export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  CUSTOMER_DECLINED: 'Customer declined estimate',
  CUSTOMER_TOOK_BACK: 'Customer took device back',
  CREATED_BY_MISTAKE: 'Created by mistake',
  DUPLICATE: 'Duplicate ticket',
  OTHER: 'Other',
};
/** Reasons that require the "Device and accessories returned to the customer" checkbox (TK-C.2). */
export const CANCEL_REASONS_REQUIRING_RETURN: readonly CancelReason[] = ['CUSTOMER_DECLINED', 'CUSTOMER_TOOK_BACK', 'OTHER'];
