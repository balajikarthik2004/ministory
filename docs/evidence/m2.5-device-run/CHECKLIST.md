# AUTH-D01 … AUTH-D12 — M2.5 physical-device verification

**Defined for this run.** No `AUTH-D*` identifiers existed in the repository
before it; these are derived from the M2.5 exit checklist in
DEVELOPMENT_ROADMAP.md and the PRD requirements they map to, so each line is
traceable to something that was already agreed rather than invented to be
passed.

| ID | Check | Maps to |
|---|---|---|
| AUTH-D01 | Cold start resolves a session and routes into the app without a sign-in wall | AUTH-01 |
| AUTH-D02 | Onboarding appears once on a fresh install, is skippable, and does not reappear | AUTH-02 |
| AUTH-D03 | Guest browsing works with no account: catalogue loads, `/me/*` succeeds against the anonymous account | AUTH-03 |
| AUTH-D04 | The refresh token is in SecureStore (Keychain/Keystore), not AsyncStorage; no credential in the JS bundle | CLAUDE.md §11, Phase 3/4 |
| AUTH-D05 | Force-stop and relaunch restores the same account from the keystore — no new guest row | AUTH-01, Phase 3 |
| AUTH-D06 | Registering from a guest session keeps watch history and favourites | AUTH-06 |
| AUTH-D07 | Login succeeds with the right password; a wrong one gives the uniform error | Phase 2 |
| AUTH-D08 | An expired access token is refreshed and the request retried, with no visible failure | AUTH-07 |
| AUTH-D09 | Several authenticated requests at once do not trigger reuse detection | ADR-45 |
| AUTH-D10 | Logout clears local credentials and returns to a guest session | AUTH-08 |
| AUTH-D11 | A password change revokes every session; the old one 401s immediately | ADR-40 |
| AUTH-D12 | `minidrama://auth/reset-password?token=…` and `…/verify-email?token=…` open the right screen | Phase 3 |

## Evidence rules for this run

- **The database is the authority** for what actually happened to a session.
  A screenshot shows what the UI claimed; the `Session` and `User` rows show
  what the server did.
- **No token, password or reset secret is written to any evidence file.**
  Session rows are reported by id, `revokedReason` and timestamps only.
- Nothing is reset, truncated or reseeded. The development database keeps its
  8 dramas, 75 episodes and the 9 pre-existing accounts.
