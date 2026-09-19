/** Current legal document versions — keep in sync with terms.html / privacy.html */
const CURRENT_TERMS_VERSION = "2026.09.18.2";
const CURRENT_PRIVACY_VERSION = "2026.09.18.2";

const PENDING_LEGAL_STORAGE_KEY = "shelfmapper_pending_legal";

function getLegalAcceptanceFromUser(user) {
  const meta = user?.user_metadata || {};
  return {
    termsVersion: String(meta.terms_version || "").trim(),
    privacyVersion: String(meta.privacy_version || "").trim(),
    termsAcceptedAt: meta.terms_accepted_at || null,
    privacyAcceptedAt: meta.privacy_accepted_at || null,
  };
}

function userHasCurrentLegalAcceptance(user) {
  const accepted = getLegalAcceptanceFromUser(user);
  return (
    accepted.termsVersion === CURRENT_TERMS_VERSION &&
    accepted.privacyVersion === CURRENT_PRIVACY_VERSION
  );
}

function buildLegalAcceptanceMetadata(now = new Date()) {
  const iso = now.toISOString();
  return {
    terms_version: CURRENT_TERMS_VERSION,
    privacy_version: CURRENT_PRIVACY_VERSION,
    terms_accepted_at: iso,
    privacy_accepted_at: iso,
  };
}

function storePendingLegalAcceptance() {
  try {
    sessionStorage.setItem(
      PENDING_LEGAL_STORAGE_KEY,
      JSON.stringify(buildLegalAcceptanceMetadata()),
    );
  } catch {
    // ignore storage failures
  }
}

function consumePendingLegalAcceptance() {
  try {
    const raw = sessionStorage.getItem(PENDING_LEGAL_STORAGE_KEY);
    sessionStorage.removeItem(PENDING_LEGAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.terms_version || !parsed?.privacy_version) return null;
    return parsed;
  } catch {
    return null;
  }
}

window.ShelfMapperLegal = {
  CURRENT_TERMS_VERSION,
  CURRENT_PRIVACY_VERSION,
  getLegalAcceptanceFromUser,
  userHasCurrentLegalAcceptance,
  buildLegalAcceptanceMetadata,
  storePendingLegalAcceptance,
  consumePendingLegalAcceptance,
};
