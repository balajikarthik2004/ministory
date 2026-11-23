import { useState, type JSX } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing, typography, MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';
import { AppText } from './AppText';
import { PressableScale } from './PressableScale';

/**
 * A labelled text input with an error slot.
 *
 * THE ERROR SLOT IS ALWAYS RENDERED, as an empty line of the right height.
 * Showing and hiding it instead makes the whole form jump upward the moment
 * validation fails, which moves the button out from under a thumb that is
 * already travelling towards it. Reserving the space costs 18dp and removes
 * a class of mis-taps (UI_UX_GUIDELINES.md §5).
 */

export interface FormFieldProps extends Omit<TextInputProps, 'style' | 'secureTextEntry'> {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  /** Shown beneath the field, in error tone. */
  error?: string | null;
  /** Renders a password field with a reveal toggle. */
  secure?: boolean;
  /** Static guidance, shown when there is no error. */
  hint?: string;
}

export function FormField({
  label,
  value,
  onChangeText,
  error,
  secure = false,
  hint,
  ...inputProps
}: FormFieldProps): JSX.Element {
  const [focused, setFocused] = useState(false);
  /*
   * A reveal toggle, not a "show password" checkbox elsewhere on the screen.
   *
   * A 12-character minimum is only reasonable if people can see what they
   * typed — otherwise the policy's effect is a stream of typos, and the usual
   * response to that is a shorter password typed carefully. NIST recommends
   * offering exactly this for the same reason.
   */
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={styles.wrapper}>
      <AppText variant="caption" tone="secondary" style={styles.label}>
        {label}
      </AppText>

      <View
        style={[styles.field, focused && styles.fieldFocused, Boolean(error) && styles.fieldError]}
      >
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secure && !revealed}
          placeholderTextColor={colors.text.tertiary}
          selectionColor={colors.accent.primary}
          underlineColorAndroid="transparent"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          {...inputProps}
        />

        {secure ? (
          <PressableScale
            onPress={() => setRevealed((previous) => !previous)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            style={styles.reveal}
          >
            <Ionicons
              name={revealed ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={colors.text.tertiary}
            />
          </PressableScale>
        ) : null}
      </View>

      {/* Reserved whatever the state — see the note above. */}
      <View style={styles.messageSlot}>
        {error ? (
          <AppText variant="caption" tone="error">
            {error}
          </AppText>
        ) : hint ? (
          <AppText variant="caption" tone="tertiary">
            {hint}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.xs },
  label: { marginLeft: spacing.xs },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH_TARGET + 6,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bg.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  fieldFocused: { borderColor: colors.accent.primary },
  fieldError: { borderColor: colors.status.error },
  input: {
    flex: 1,
    color: colors.text.primary,
    ...typography.body,
    // Tamil renders taller than Latin at the same size (ui-tokens/typography),
    // so the field grows rather than clipping the glyphs.
    paddingVertical: spacing.sm,
  },
  reveal: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageSlot: { minHeight: 18, marginLeft: spacing.xs },
});
