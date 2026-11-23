import { create } from 'zustand';
import { MOCK_LANGUAGES, MOCK_PROFILE } from '../data/catalogue.mock';

/**
 * Viewing preferences.
 *
 * Separate from the library store on purpose: the player subscribes to `muted`
 * and would re-render on every favourite toggle if the two shared a store.
 *
 * `preferredLanguageId` is the content language — which dramas the catalogue
 * offers — not the UI language. The M2.1 brief keeps the interface in English
 * while the architecture stays ready for Telugu and Hindi, and separating the
 * two is what makes that possible: a viewer can read an English interface and
 * watch Tamil content, which is the actual launch case.
 *
 * NOT PERSISTED in M2.1, for the same reason as the library store — these live
 * on `UserProfile` server-side (PATCH /me/profile) and a device-local copy
 * would need reconciling in M3.
 */

interface PreferencesState {
  /** Content language filter. Null means "no filter". */
  preferredLanguageId: string | null;
  /** PLY-05: auto-advance at the end of an episode. */
  autoplayNext: boolean;
  /**
   * Start muted. A drama feed that blares audio the instant it opens is the
   * single most complained-about behaviour in this category, and the control
   * is one tap away in the player overlay.
   */
  muted: boolean;

  setPreferredLanguage: (languageId: string | null) => void;
  setAutoplayNext: (enabled: boolean) => void;
  toggleMuted: () => void;
  setMuted: (muted: boolean) => void;
}

const DEFAULT_LANGUAGE_ID = MOCK_PROFILE.preferredLanguage?.id ?? MOCK_LANGUAGES[0]?.id ?? null;

export const usePreferencesStore = create<PreferencesState>((set) => ({
  preferredLanguageId: DEFAULT_LANGUAGE_ID,
  autoplayNext: MOCK_PROFILE.autoplayNext,
  muted: true,

  setPreferredLanguage: (languageId) => set({ preferredLanguageId: languageId }),
  setAutoplayNext: (enabled) => set({ autoplayNext: enabled }),
  toggleMuted: () => set((state) => ({ muted: !state.muted })),
  setMuted: (muted) => set({ muted }),
}));
