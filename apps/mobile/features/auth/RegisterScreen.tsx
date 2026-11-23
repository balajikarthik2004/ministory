import { useCallback, useMemo, useState, type JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { emailSchema, passwordSchema } from '@minidrama/contracts';
import { spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { FormField } from '../../components/primitives/FormField';
import { PressableScale } from '../../components/primitives/PressableScale';
import { AuthScreenLayout } from './AuthScreenLayout';
import { FormBanner } from './FormBanner';
import { session, authApi } from '../../services/auth/session';
import { useSessionStore } from '../../store/session.store';
import { applyAccountChange } from '../../services/auth/account-change';
import { toAppError } from '../../services/errors';

/**
 * Create an account.
 *
 * TWO PATHS BEHIND ONE FORM, chosen by whether there is a guest session:
 *
 *   GUEST PRESENT  → `POST /auth/merge`. The anonymous account is promoted
 *                    in place, keeping its watch history and favourites
 *                    (PRD AUTH-06), and the viewer is signed in immediately.
 *   NO SESSION     → `POST /auth/register`, which answers neutrally and
 *                    sends a confirmation email. The viewer then signs in.
 *
 * THE REGISTER PATH DOES NOT SIGN ANYONE IN, and that is not an oversight —
 * registration's response is deliberately identical whether or not the
 * address was already taken, so it cannot carry a session (see
 * `registerResponseSchema`). The merge path can, because it requires the
 * password for an existing address and so is not an enumeration oracle.
 *
 * The practical consequence is that a brand-new user with no guest session
 * registers, then signs in. In practice almost nobody takes that path: the
 * app creates a guest session on first launch, so the merge branch is the
 * normal one.
 */
export function RegisterScreen(): JSX.Element {
  const router = useRouter();
  const canUpgrade = useSessionStore((state) => state.canUpgrade);

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
   * Validated against the SHARED contract schemas, not a regex written here.
   *
   * The server validates with `emailSchema` and `passwordSchema` from
   * `@minidrama/contracts`; using the same objects means the client cannot
   * drift into accepting something the server rejects, which is the usual way
   * a form ends up showing a server error for a field it told the user was
   * fine (ADR-05).
   */
  const emailError = useMemo(() => {
    if (email.length === 0) return null;
    const result = emailSchema.safeParse(email);
    return result.success ? null : (result.error.issues[0]?.message ?? 'Enter a valid email.');
  }, [email]);

  const passwordError = useMemo(() => {
    if (password.length === 0) return null;
    const result = passwordSchema.safeParse(password);
    return result.success ? null : (result.error.issues[0]?.message ?? null);
  }, [password]);

  const canSubmit =
    email.length > 0 && password.length > 0 && !emailError && !passwordError && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);

    const name = displayName.trim();

    try {
      if (canUpgrade) {
        const { moved } = await session.upgradeGuest({
          email: email.trim(),
          password,
          ...(name ? { displayName: name } : {}),
        });
        await applyAccountChange();

        // Reported honestly rather than claimed: `moved` is what the server
        // says it carried across, and it is zero when the guest row was
        // promoted in place (nothing had to move).
        router.replace({
          pathname: '/home',
          params: moved > 0 ? { merged: String(moved) } : {},
        });
        return;
      }

      const response = await authApi.register({
        email: email.trim(),
        password,
        ...(name ? { displayName: name } : {}),
      });
      setNotice(response.message);
    } catch (cause) {
      setError(toAppError(cause).message);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, canUpgrade, displayName, email, password, router]);

  return (
    <AuthScreenLayout
      title="Create your account"
      subtitle={
        canUpgrade
          ? 'Your watch history and saved dramas come with you.'
          : 'Save your progress and watch across devices.'
      }
      footer={
        <View style={styles.footer}>
          <AppText variant="body" tone="secondary">
            Already have an account?
          </AppText>
          <PressableScale
            onPress={() => router.replace('/login')}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
          >
            <AppText variant="bodyStrong" tone="accent">
              Sign in
            </AppText>
          </PressableScale>
        </View>
      }
    >
      <FormBanner message={error} tone="error" />
      <FormBanner message={notice} tone="success" />

      <FormField
        label="Name"
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="What should we call you?"
        autoCapitalize="words"
        autoComplete="name"
        hint="Optional."
      />

      <FormField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        error={emailError}
      />

      <FormField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="At least 12 characters"
        secure
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        error={passwordError}
        hint="Twelve characters or more. A phrase you'll remember beats a short, complicated one."
        onSubmitEditing={() => void handleSubmit()}
      />

      <Button
        label={canUpgrade ? 'Create account and keep my progress' : 'Create account'}
        onPress={() => void handleSubmit()}
        loading={submitting}
        disabled={!canSubmit}
        fullWidth
        size="lg"
      />

      {notice ? (
        <Button
          label="Go to sign in"
          onPress={() => router.replace('/login')}
          variant="secondary"
          fullWidth
        />
      ) : null}
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
});
