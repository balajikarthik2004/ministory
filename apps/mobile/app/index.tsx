import type { JSX } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_BASE_PATH } from '@minidrama/contracts';
import { colors, spacing, typography } from '@minidrama/ui-tokens';

/**
 * Milestone 1.1 placeholder screen.
 *
 * Scaffolding, not a product screen. It exists to prove Expo Router renders and
 * that both workspace packages resolve through Metro. The splash, onboarding
 * and home screens are Milestone 2.
 */
export default function FoundationScreen(): JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <Text style={styles.eyebrow}>MILESTONE 1.1</Text>
      <Text style={styles.title}>MiniDrama</Text>
      <Text style={styles.body}>
        Foundation scaffold. Expo Router is running and the workspace packages resolve.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>API base path</Text>
        <Text style={styles.cardValue}>{API_BASE_PATH}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Accent token</Text>
        <View style={styles.swatchRow}>
          <View style={styles.swatch} />
          <Text style={styles.cardValue}>{colors.accent.primary}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    paddingHorizontal: spacing.lg,
  },
  eyebrow: {
    ...typography.micro,
    color: colors.text.tertiary,
    letterSpacing: 1.5,
  },
  title: {
    ...typography.h1,
    color: colors.text.primary,
    marginTop: spacing.xs,
  },
  body: {
    ...typography.body,
    color: colors.text.secondary,
    marginTop: spacing.sm,
  },
  card: {
    backgroundColor: colors.bg.card,
    borderRadius: spacing.md,
    padding: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.xs,
  },
  cardLabel: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  cardValue: {
    ...typography.bodyStrong,
    color: colors.text.primary,
  },
  swatchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  swatch: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent.primary,
  },
});
