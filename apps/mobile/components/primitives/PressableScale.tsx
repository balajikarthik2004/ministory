import type { JSX, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { Animated, Pressable, type PressableProps, type ViewStyle } from 'react-native';
import { duration } from '@minidrama/ui-tokens';

/**
 * Press feedback: a short scale-down on press-in, release on press-out.
 *
 * Uses React Native's own `Animated` with `useNativeDriver`, not Reanimated.
 * Reanimated is in the CLAUDE.md §3 stack and will be worth adding when the
 * app needs gesture-driven or layout animation, but a transform fade is
 * already driven entirely on the UI thread by the native driver, and M2.1's
 * brief asks for no unnecessary dependencies. If a later milestone needs
 * Reanimated, this component is the single place that changes.
 *
 * UI_UX_GUIDELINES.md §7: every interactive element is at least 44x44dp. This
 * component does not enforce that — callers size themselves or pass `hitSlop`
 * via `hitSlopFor()` — but it does make the target feel pressed, which is what
 * stops a user tapping a poster three times on a slow device.
 *
 * ONE ELEMENT, NOT TWO
 * --------------------
 * The caller's style goes on an animated `Pressable`, not on a wrapper inside
 * it. An earlier version rendered `<Pressable><Animated.View style={style}>`,
 * which quietly dropped every layout property the caller passed: the flex
 * child of the parent was the unstyled `Pressable`, so `flex`, `alignSelf`,
 * `width` and margins never took effect. On a device that showed up as the
 * Profile screen's three stat tiles — each `flex: 1` — collapsing to the width
 * of their own labels and crowding into the left third of the screen.
 *
 * Animating the `Pressable` itself keeps layout, touch handling and the
 * transform on a single element, so a caller's style means what it says.
 */

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  children: ReactNode;
  style?: ViewStyle | ViewStyle[];
  /** How far to scale down. Posters take a lighter press than buttons. */
  activeScale?: number;
}

export function PressableScale({
  children,
  style,
  activeScale = 0.96,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps): JSX.Element {
  // `useState` with a lazy initialiser rather than `useRef(...).current`:
  // both create the value once, but reading `.current` during render is
  // flagged by react-hooks/refs, and an Animated.Value genuinely is render
  // state here - it is read by the style on every render.
  const [scale] = useState(() => new Animated.Value(1));

  const animateTo = useCallback(
    (value: number, ms: number) => {
      Animated.timing(scale, {
        toValue: value,
        duration: ms,
        useNativeDriver: true,
      }).start();
    },
    [scale],
  );

  const handlePressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    (event) => {
      animateTo(activeScale, duration.instant);
      onPressIn?.(event);
    },
    [activeScale, animateTo, onPressIn],
  );

  const handlePressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    (event) => {
      animateTo(1, duration.fast);
      onPressOut?.(event);
    },
    [animateTo, onPressOut],
  );

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * Created once at module scope. Building it inside the component would make a
 * new component type on every render, which remounts the subtree and loses
 * both the press state and the running animation.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
