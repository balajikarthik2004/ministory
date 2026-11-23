import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, type ViewStyle } from 'react-native';
import { colors, radius } from '@minidrama/ui-tokens';

/**
 * A pulsing placeholder block.
 *
 * UI_UX_GUIDELINES.md §5 is explicit: loading states are skeletons shaped like
 * the content that is coming, never a centred spinner on a full screen. A
 * skeleton tells the user what is about to appear; a spinner only tells them
 * they are waiting.
 *
 * The pulse is an opacity animation on the native driver, so it does not touch
 * the JS thread while a list is settling.
 */

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle | ViewStyle[];
}

export function Skeleton({
  width = '100%',
  height = 16,
  borderRadius = radius.sm,
  style,
}: SkeletonProps): JSX.Element {
  const [pulse] = useState(() => new Animated.Value(0.45));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.block, { width, height, borderRadius, opacity: pulse }, style]}
    />
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.bg.card,
  },
});
