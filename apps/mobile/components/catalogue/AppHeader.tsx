import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../primitives/AppText';
import { IconButton } from '../primitives/IconButton';
import { Wordmark } from './Wordmark';

/**
 * The home header: MiniDrama branding on the left, search on the right.
 *
 * `floating` draws it over the featured banner with no background of its own.
 * The banner's own top scrim is what keeps it legible — a solid header bar
 * above a cinematic banner cuts the image in half and makes the screen look
 * like a list app rather than a streaming one.
 */

export interface AppHeaderProps {
  onSearch: () => void;
  insetTop: number;
  floating?: boolean;
  title?: string;
}

export function AppHeader({
  onSearch,
  insetTop,
  floating = false,
  title,
}: AppHeaderProps): JSX.Element {
  return (
    <View
      style={[
        styles.header,
        floating ? styles.floating : styles.solid,
        { paddingTop: insetTop + spacing.sm },
      ]}
      pointerEvents="box-none"
    >
      {title ? (
        <AppText variant="h1" numberOfLines={1} style={styles.flex}>
          {title}
        </AppText>
      ) : (
        <Wordmark size="sm" />
      )}

      <IconButton
        name="search"
        onPress={onSearch}
        surface={floating ? 'glass' : 'none'}
        accessibilityLabel="Search"
        accessibilityHint="Opens search"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  floating: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: 'transparent',
  },
  solid: {
    backgroundColor: colors.bg.primary,
  },
  flex: {
    flex: 1,
  },
});
