const { AppError } = require("../errors.cjs");

const LIKENESS_TERMS_VERSION = "2026-07-24";

function requireLikenessAcceptance(value) {
  if (
    value?.termsVersion !== LIKENESS_TERMS_VERSION ||
    value?.adultConfirmed !== true ||
    value?.rightsConfirmed !== true ||
    value?.consentConfirmed !== true ||
    value?.syntheticDisclosureConfirmed !== true ||
    value?.misuseResponsibilityConfirmed !== true ||
    value?.providerTermsConfirmed !== true
  ) {
    throw new AppError("VOICE_LIKENESS_ACCEPTANCE_REQUIRED", "Accept every voice-likeness term before creating a custom voice.");
  }
  const legalName = String(value.legalName || "").trim();
  if (legalName.length < 2 || legalName.length > 120) {
    throw new AppError("INVALID_VOICE_LIKENESS_ACCEPTANCE", "Enter the consenting adult’s full legal name.");
  }
  return {
    termsVersion: LIKENESS_TERMS_VERSION,
    legalName,
    relationship: value.relationship === "authorized_representative" ? "authorized_representative" : "self",
    adultConfirmed: true,
    rightsConfirmed: true,
    consentConfirmed: true,
    syntheticDisclosureConfirmed: true,
    misuseResponsibilityConfirmed: true,
    providerTermsConfirmed: true
  };
}

module.exports = { LIKENESS_TERMS_VERSION, requireLikenessAcceptance };
