import type { JSX } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing, typography, MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';
import { IconButton } from './IconButton';

/**
 * The search field.
 *
 * The clear control appears only when there is something to clear — a
 * permanently visible X on an empty field is a dead target, and
 * UI_UX_GUIDELINES.md §5 treats a control that does nothing as a defect.
 */

export interface SearchInputProps {
  value: string;
  onChangeText: (value: string) => void;
  onClear: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
}

export function SearchInput({
  value,
  onChangeText,
  onClear,
  placeholder = 'Search dramas, genres',
  autoFocus = false,
  onSubmitEditing,
}: SearchInputProps): JSX.Element {
  return (
    <View style={styles.wrapper}>
      <Ionicons name="search" size={18} color={colors.text.tertiary} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text.tertiary}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={onSubmitEditing}
        selectionColor={colors.accent.primary}
        accessibilityLabel="Search dramas"
        // Android draws its own underline on a focused TextInput, which fights
        // the rounded container.
        underlineColorAndroid="transparent"
      />
      {value.length > 0 ? (
        <IconButton
          name="close-circle"
          size={18}
          color={colors.text.tertiary}
          onPress={onClear}
          accessibilityLabel="Clear search"
          accessibilityHint="Removes the current search text"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bg.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    minHeight: MIN_TOUCH_TARGET + 4,
  },
  input: {
    flex: 1,
    color: colors.text.primary,
    fontSize: typography.body.fontSize,
    // Vertical padding rather than a fixed height, so Tamil input does not
    // clip when the keyboard language changes.
    paddingVertical: spacing.sm,
  },
});
