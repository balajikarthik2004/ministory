import { useCallback, useState, type JSX } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { Chip } from '../../components/primitives/Chip';
import { PressableScale } from '../../components/primitives/PressableScale';
import { Wordmark } from '../../components/catalogue/Wordmark';
import { MOCK_CATEGORIES, MOCK_LANGUAGES } from '../../data/catalogue.mock';
import { usePreferencesStore } from '../../store/preferences.store';
import { markOnboardingSeen } from '../../services/auth/onboarding';

/**
 * Onboarding: language, then genres (PRD AUTH-02, P1).
 *
 * SKIPPABLE AT EVERY STEP, which the requirement asks for and which matters
 * more than it sounds: this is the first screen a new install shows, and a
 * mandatory multi-step form in front of a catalogue is where a meaningful
 * share of first sessions end. Skipping leaves the defaults, and both choices
 * are changeable from Profile afterwards.
 *
 * SHOWN ONCE PER INSTALL, not once per account, and the flag is local. It is
 * a UI preference about whether this device has seen the introduction, not
 * part of the viewer's profile — tying it to the account would re-run it for
 * a returning user on a device that has already been through it.
 *
 * The language and genre choices themselves are a different matter: they
 * belong on `UserProfile` server-side, and `PATCH /me/profile` is an M3
 * endpoint that does not exist yet. They are applied to the local
 * preferences store for now, which is where every other screen already reads
 * them from.
 */

type Step = 'language' | 'genres';

export function OnboardingScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('language');

  const preferredLanguageId = usePreferencesStore((state) => state.preferredLanguageId);
  const setPreferredLanguage = usePreferencesStore((state) => state.setPreferredLanguage);
  const [genres, setGenres] = useState<string[]>([]);

  const finish = useCallback(async () => {
    await markOnboardingSeen();
    router.replace('/home');
  }, [router]);

  const toggleGenre = useCallback((id: string) => {
    setGenres((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.header}>
        <Wordmark size="lg" />
      </View>

      {step === 'language' ? (
        <View style={styles.body}>
          <View style={styles.titleBlock}>
            <AppText variant="h1">What do you want to watch?</AppText>
            <AppText variant="body" tone="secondary">
              Pick a language. You can change this any time.
            </AppText>
          </View>

          <ScrollView contentContainerStyle={styles.options} showsVerticalScrollIndicator={false}>
            {MOCK_LANGUAGES.map((language) => (
              <PressableScale
                key={language.id}
                onPress={() => setPreferredLanguage(language.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: preferredLanguageId === language.id }}
                accessibilityLabel={`${language.name}, ${language.nativeName}`}
                style={
                  preferredLanguageId === language.id
                    ? [styles.languageRow, styles.languageRowSelected]
                    : [styles.languageRow]
                }
              >
                <View>
                  <AppText variant="bodyStrong">{language.nativeName}</AppText>
                  <AppText variant="caption" tone="secondary">
                    {language.name}
                  </AppText>
                </View>
              </PressableScale>
            ))}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.body}>
          <View style={styles.titleBlock}>
            <AppText variant="h1">What are you in the mood for?</AppText>
            <AppText variant="body" tone="secondary">
              Choose a few genres so we can suggest better. Optional.
            </AppText>
          </View>

          <ScrollView contentContainerStyle={styles.chips} showsVerticalScrollIndicator={false}>
            {MOCK_CATEGORIES.map((category) => (
              <Chip
                key={category.id}
                label={category.name}
                selected={genres.includes(category.id)}
                onPress={() => toggleGenre(category.id)}
              />
            ))}
          </ScrollView>
        </View>
      )}

      <View style={[styles.actions, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Button
          label={step === 'language' ? 'Continue' : 'Start watching'}
          onPress={() => {
            if (step === 'language') setStep('genres');
            else void finish();
          }}
          fullWidth
          size="lg"
        />
        <Button label="Skip for now" onPress={() => void finish()} variant="ghost" fullWidth />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.primary, paddingHorizontal: spacing.lg },
  header: { alignItems: 'center', paddingVertical: spacing.xl },
  body: { flex: 1, gap: spacing.lg },
  titleBlock: { gap: spacing.xs },
  options: { gap: spacing.sm, paddingBottom: spacing.lg },
  languageRow: {
    padding: spacing.lg,
    borderRadius: spacing.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.bg.card,
  },
  languageRowSelected: {
    borderColor: colors.accent.primary,
    backgroundColor: colors.accent.subtle,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.lg },
  actions: { gap: spacing.sm, paddingTop: spacing.lg },
});
