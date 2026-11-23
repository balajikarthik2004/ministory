import type { JSX } from 'react';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@minidrama/ui-tokens';
import { EXPERIMENTS, UNCOLLECTABLE_IN_APP } from '../../experiments/video-player/types';

export default function SpikeHomeScreen(): JSX.Element {
  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>MILESTONE 1.2 · EXPERIMENTAL</Text>
      <Text style={styles.title}>Video player spike</Text>
      <Text style={styles.body}>
        Throwaway code measuring three player-management strategies for the vertical feed. Not the
        production player.
      </Text>

      <View style={styles.checklist}>
        <Text style={styles.checklistTitle}>Before running</Text>
        <Text style={styles.checklistItem}>1. node tools/video-fixtures/generate.mjs</Text>
        <Text style={styles.checklistItem}>2. node tools/video-fixtures/serve.mjs</Text>
        <Text style={styles.checklistItem}>
          3. Paste the printed device URL into the run screen
        </Text>
        <Text style={styles.checklistItem}>4. Start adb sampling if measuring memory</Text>
      </View>

      {EXPERIMENTS.map((experiment) => (
        <Pressable
          key={experiment.id}
          style={styles.card}
          onPress={() =>
            router.push({
              pathname: '/(experiments)/[experiment]',
              params: { experiment: experiment.id },
            })
          }
        >
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{experiment.title}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {experiment.playerCount} player{experiment.playerCount > 1 ? 's' : ''}
              </Text>
            </View>
          </View>
          <Text style={styles.cardBody}>{experiment.summary}</Text>
        </Pressable>
      ))}

      <View style={styles.note}>
        <Text style={styles.noteTitle}>Not measured in-app</Text>
        {Object.entries(UNCOLLECTABLE_IN_APP).map(([metric, how]) => (
          <Text key={metric} style={styles.noteItem}>
            <Text style={styles.noteMetric}>{metric}</Text> — {how}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg.primary },
  content: { padding: spacing.lg, paddingBottom: spacing['3xl'] },
  eyebrow: { ...typography.micro, color: colors.status.warning, letterSpacing: 1.5 },
  title: { ...typography.h1, color: colors.text.primary, marginTop: spacing.xs },
  body: { ...typography.body, color: colors.text.secondary, marginTop: spacing.sm },
  checklist: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: spacing.md,
    backgroundColor: colors.bg.secondary,
    gap: spacing.xs,
  },
  checklistTitle: { ...typography.caption, color: colors.accent.primary, marginBottom: spacing.xs },
  checklistItem: { ...typography.micro, color: colors.text.secondary },
  card: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: spacing.md,
    backgroundColor: colors.bg.card,
    minHeight: 44,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { ...typography.h3, color: colors.text.primary, flexShrink: 1 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.accent.subtle,
  },
  badgeText: { ...typography.micro, color: colors.accent.primary },
  cardBody: { ...typography.caption, color: colors.text.secondary, marginTop: spacing.sm },
  note: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    gap: spacing.sm,
  },
  noteTitle: { ...typography.caption, color: colors.text.primary },
  noteItem: { ...typography.micro, color: colors.text.tertiary },
  noteMetric: { color: colors.text.secondary },
});
