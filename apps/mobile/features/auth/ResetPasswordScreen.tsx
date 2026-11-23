import { useCallback, useMemo, useState, type JSX } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { passwordSchema } from '@minidrama/contracts';
import { Button } from '../../components/primitives/Button';
import { FormField } from '../../components/primitives/FormField';
import { AuthScreenLayout } from './AuthScreenLayout';
import { FormBanner } from './FormBanner';
import { authApi } from '../../services/auth/session';
import { toAppError } from '../../services/errors';

/**
 * Set a new password from a reset link.
 *
 * THE TOKEN ARRIVES TWO WAYS. The email link is `minidrama://auth/reset-password?token=…`,
 * which expo-router delivers as a route param; and the field stays editable so
 * a token can be pasted when the deep link does not fire — which it does not,
 * on a device where the app is not the registered handler for the scheme, or
 * when the viewer opens the mail on a different device.
 *
 * Making the field editable rather than hidden is what keeps the flow usable
 * in exactly the situations where a deep link fails, which are the situations
 * where someone is already frustrated enough to be resetting a password.
 */
export function ResetPasswordScreen(): JSX.Element {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();

  const [token, setToken] = useState(params.token ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const passwordError = useMemo(() => {
    if (password.length === 0) return null;
    const result = passwordSchema.safeParse(password);
    return result.success ? null : (result.error.issues[0]?.message ?? null);
  }, [password]);

  const canSubmit = token.trim().length > 0 && password.length > 0 && !passwordError && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      await authApi.resetPassword({ token: token.trim(), newPassword: password });
      setDone(true);
    } catch (cause) {
      setError(toAppError(cause).message);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, token]);

  if (done) {
    return (
      <AuthScreenLayout
        title="Password updated"
        subtitle="Every device that was signed in has been signed out. Sign in with your new password to continue."
        showBack={false}
      >
        <Button label="Sign in" onPress={() => router.replace('/login')} fullWidth size="lg" />
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title="Choose a new password"
      subtitle="Paste the code from your email if it wasn't filled in automatically."
    >
      <FormBanner message={error} tone="error" />

      <FormField
        label="Reset code"
        value={token}
        onChangeText={setToken}
        placeholder="From your reset email"
        autoCapitalize="none"
        autoCorrect={false}
        // The token is a base64url string with no spaces; a keyboard that
        // auto-capitalises or autocorrects it produces a code that looks right
        // and is not.
        keyboardType="default"
      />

      <FormField
        label="New password"
        value={password}
        onChangeText={setPassword}
        placeholder="At least 12 characters"
        secure
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        error={passwordError}
        onSubmitEditing={() => void handleSubmit()}
      />

      <Button
        label="Set new password"
        onPress={() => void handleSubmit()}
        loading={submitting}
        disabled={!canSubmit}
        fullWidth
        size="lg"
      />
    </AuthScreenLayout>
  );
}
