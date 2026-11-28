#pragma once

#include <cstdint>
#include <string>

namespace rea {

constexpr std::uint32_t kPrivateDaclAccessDenied = 5;

struct PrivateDaclReadback {
  bool hasAcl = false;
  std::uint32_t aceCount = 0;
  bool protectedDacl = false;
  bool tokenUserEqualsSystem = false;
};

struct PrivateDaclTrusteeOutcome {
  bool ok = true;
  std::uint32_t win32Code = 0;
  std::string constraint;
};

inline std::string formatPrivateDaclTrusteeReadback(const char* constraint,
                                                    const PrivateDaclReadback& readback) {
  std::string text = constraint;
  text += "; ace_count=";
  text += readback.hasAcl ? std::to_string(readback.aceCount) : "absent";
  text += " protected=";
  text += readback.protectedDacl ? "1" : "0";
  text += " token_user_equals_system=";
  text += readback.tokenUserEqualsSystem ? "1" : "0";
  return text;
}

class PrivateDaclTrusteeVerifier {
 public:
  explicit PrivateDaclTrusteeVerifier(PrivateDaclReadback readback) noexcept
      : readback_(readback) {}

  PrivateDaclTrusteeOutcome verifyAceCount() const {
    if (!readback_.hasAcl || readback_.aceCount != 2) {
      return {false, kPrivateDaclAccessDenied,
              formatPrivateDaclTrusteeReadback("Private DACL contains unexpected trustees",
                                               readback_)};
    }
    return {};
  }

  // The process user can be SYSTEM, so one ACE can satisfy both trustee flags.
  PrivateDaclTrusteeOutcome observeAce(bool isUser, bool isSystem) {
    if (!isUser && !isSystem) {
      return {false, kPrivateDaclAccessDenied,
              formatPrivateDaclTrusteeReadback("Private DACL permits an unrelated principal",
                                               readback_)};
    }
    if (isUser) seenUser_ = true;
    if (isSystem) seenSystem_ = true;
    return {};
  }

  PrivateDaclTrusteeOutcome finish() const {
    if (!(seenUser_ && seenSystem_)) {
      return {false, kPrivateDaclAccessDenied,
              formatPrivateDaclTrusteeReadback(
                  "Private DACL must allow only current user and SYSTEM", readback_)};
    }
    return {};
  }

 private:
  PrivateDaclReadback readback_;
  bool seenUser_ = false;
  bool seenSystem_ = false;
};

}  // namespace rea
