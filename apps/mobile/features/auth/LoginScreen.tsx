import { useCallback, useState, type JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { FormField } from '../../components/primitives/FormField';
import { PressableScale } from '../../components/primitives/PressableScale';
import { AuthScreenLayout } from './AuthScreenLayout';
import { FormBanner } from './FormBanner';
import { session } from '../../services/auth/session';
import { toAppError } from '../../services/errors';
import { applyAccountChange } from '../../services/auth/account-change';

/**
 * Sign in.
 *
 * THE ERROR COPY IS THE SERVER'S, UNCHANGED. "That email address and password
 * do not match an account" is one sentence for a wrong password and for an
 * address with no account, and that uniformity is deliberate — see
 * `auth.service.ts`. Rewriting it here into something friendlier, like "we
 * don't know that address", would undo the enumeration defence from the one
 * place nobody would think to look for it.
 */
export function LoginScreen(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      await session.signIn(email.trim(), password);
      /*
       * The new account's library replaces the previous view before we
       * navigate. Without it the guest's favourites stay on screen until
       * something happens to refetch — see `applyAccountChange`.
       */
      await applyAccountChange();
      router.replace('/home');
    } catch (cause) {
      setError(toAppError(cause).message);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, email, password, router]);

  return (
    <AuthScreenLayout
      title="Welcome back"
      subtitle="Sign in to pick up where you left off."
      footer={
        <View style={styles.footer}>
          <AppText variant="body" tone="secondary">
            New to MiniDrama?
          </AppText>
          <PressableScale
            onPress={() => router.push('/register')}
            accessibilityRole="button"
            accessibilityLabel="Create an account"
          >
            <AppText variant="bodyStrong" tone="accent">
              Create an account
            </AppText>
          </PressableScale>
        </View>
      }
    >
      <FormBanner message={error} tone="error" />

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
        returnKeyType="next"
      />

      <FormField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="Your password"
        secure
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void handleSubmit()}
      />

      <PressableScale
        onPress={() => router.push('/forgot-password')}
        accessibilityRole="button"
        accessibilityLabel="Forgot your password"
        style={styles.forgot}
      >
        <AppText variant="caption" tone="accent">
          Forgot your password?
        </AppText>
      </PressableScale>

      <Button
        label="Sign in"
        onPress={() => void handleSubmit()}
        loading={submitting}
        disabled={!canSubmit}
        fullWidth
        size="lg"
      />

      <Button
        label="Keep browsing without an account"
        onPress={() => router.replace('/home')}
        variant="ghost"
        fullWidth
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  forgot: { alignSelf: 'flex-end' },
});
