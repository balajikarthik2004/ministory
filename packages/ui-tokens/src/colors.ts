/**
 * Colour tokens. See docs/UI_UX_GUIDELINES.md §1.
 *
 * Dark-only by design: a cinematic viewing app has no light mode, and a forced
 * light theme would fight every poster on the screen.
 *
 * Hard rule: no raw hex appears in a component file. If a component needs a
 * colour that is not here, the token set is missing one - add it here.
 */
export const colors = {
  bg: {
    primary: '#090A0F',
    secondary: '#151720',
    card: '#1D202B',
    elevated: '#262A38',
  },
  accent: {
    primary: '#F5B544',
    pressed: '#D99B2E',
    subtle: 'rgba(245, 181, 68, 0.12)',
  },
  text: {
    primary: '#FFFFFF',
    secondary: '#A4A8B5',
    tertiary: '#6B7081',
    onAccent: '#17120A',
  },
  border: {
    subtle: 'rgba(255, 255, 255, 0.08)',
    strong: 'rgba(255, 255, 255, 0.16)',
  },
  status: {
    error: '#EF4444',
    success: '#22C55E',
    warning: '#F59E0B',
  },
  overlay: {
    scrim: 'rgba(9, 10, 15, 0.72)',
  },
} as const;

export type Colors = typeof colors;
