import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../primitives/AppText';
import { Button } from '../primitives/Button';

/**
 * Error state — a human-readable cause plus a retry.
 *
 * UI_UX_GUIDELINES.md §5 and CLAUDE.md §11: technical detail goes to the error
 * monitor, never to the screen. Copy never blames the user, never shows an
 * error code, and always says what to do next.
 *
 * `message` is therefore expected to be a *presentable* string already — the
 * query layer maps failures to safe copy (see services/errors.ts). Passing a
 * raw exception message through here would leak internals onto a screen.
 */

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  /** Compact form, for a failed rail inside an otherwise healthy screen. */
  compact?: boolean;
}

export function ErrorState({
  title = "That didn't load",
  message,
  onRetry,
  retrying = false,
  compact = false,
}: ErrorStateProps): JSX.Element {
  return (
    <View style={[styles.container, compact ? styles.compact : null]}>
      <View style={[styles.iconRing, compact ? styles.iconRingCompact : null]}>
        <Ionicons
          name="cloud-offline-outline"
          size={compact ? 20 : 28}
          color={colors.status.error}
        />
      </View>
      <AppText variant={compact ? 'bodyStrong' : 'h3'} style={styles.centered}>
        {title}
      </AppText>
      <AppText variant={compact ? 'caption' : 'body'} tone="secondary" style={styles.message}>
        {message}
      </AppText>
      {onRetry ? (
        <Button
          label="Try again"
          onPress={onRetry}
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          loading={retrying}
          icon="refresh"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing['3xl'],
    gap: spacing.md,
  },
  compact: {
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  iconRing: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconRingCompact: {
    width: 40,
    height: 40,
  },
  centered: {
    textAlign: 'center',
  },
  message: {
    textAlign: 'center',
    maxWidth: 300,
  },
});
