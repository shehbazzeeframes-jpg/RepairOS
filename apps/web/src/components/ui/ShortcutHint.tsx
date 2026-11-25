import { HStack } from '@astryxdesign/core/HStack';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Text } from '@astryxdesign/core/Text';

export interface ShortcutHintProps {
  /**
   * Astryx Kbd combo: "mod+enter", "/", "escape", "n", "up". `mod` is ⌘ on macOS, Ctrl elsewhere.
   * An array shows alternatives side by side (["up", "down"] → ↑ ↓).
   */
  keys: string | readonly string[];
  /** What the shortcut does ("Create ticket"). */
  label: string;
}

/** "⌘ ↵ Create ticket": a key combo next to its action, for hint lines, footers and menus. */
export function ShortcutHint({ keys, label }: ShortcutHintProps) {
  return (
    <HStack gap={1} vAlign="center">
      {(typeof keys === 'string' ? [keys] : keys).map((k) => (
        <Kbd key={k} keys={k} />
      ))}
      <Text type="supporting" color="secondary">
        {label}
      </Text>
    </HStack>
  );
}

/** A row of hints that wraps at narrow widths ("Keyboard: ↑↓ choose · ↵ pick · ⌘↵ create"). */
export function ShortcutHints({
  hints,
  label = 'Keyboard shortcuts',
}: {
  hints: readonly ShortcutHintProps[];
  label?: string;
}) {
  return (
    <HStack gap={4} wrap="wrap" vAlign="center" aria-label={label} role="group">
      {hints.map((h) => (
        <ShortcutHint key={`${String(h.keys)}:${h.label}`} {...h} />
      ))}
    </HStack>
  );
}
