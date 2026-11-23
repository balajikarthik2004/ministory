import type { JSX } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '@minidrama/ui-tokens';
import { ExperimentScreen } from '../../experiments/video-player/screens/ExperimentScreen';
import { EXPERIMENTS, type ExperimentId } from '../../experiments/video-player/types';

function isExperimentId(value: string): value is ExperimentId {
  return EXPERIMENTS.some((entry) => entry.id === value);
}

export default function ExperimentRoute(): JSX.Element {
  const { experiment } = useLocalSearchParams<{ experiment: string }>();

  if (!experiment || !isExperimentId(experiment)) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>Unknown experiment: {String(experiment)}</Text>
      </View>
    );
  }

  return <ExperimentScreen experimentId={experiment} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary, padding: spacing.lg },
  text: { ...typography.body, color: colors.status.error },
});
