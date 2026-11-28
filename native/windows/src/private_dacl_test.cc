#include "private_dacl.hpp"

#include <cstdlib>
#include <initializer_list>
#include <iostream>
#include <string>
#include <utility>

namespace {

int failures = 0;

void expect(bool condition, const char* description) {
  if (condition) return;
  ++failures;
  std::cerr << "failed: " << description << '\n';
}

using AceMatch = std::pair<bool, bool>;

rea::PrivateDaclTrusteeOutcome evaluate(
    rea::PrivateDaclReadback readback,
    std::initializer_list<AceMatch> aces) {
  rea::PrivateDaclTrusteeVerifier verifier(readback);
  if (const auto countOutcome = verifier.verifyAceCount(); !countOutcome.ok)
    return countOutcome;
  for (const auto& [isUser, isSystem] : aces) {
    if (const auto step = verifier.observeAce(isUser, isSystem); !step.ok)
      return step;
  }
  return verifier.finish();
}

void testValidUserAndSystemPass() {
  const auto forward = evaluate({true, 2, true, false}, {{true, false}, {false, true}});
  expect(forward.ok && forward.win32Code == 0 && forward.constraint.empty(),
         "current user + SYSTEM passes in forward order");

  const auto reverse = evaluate({true, 2, false, false}, {{false, true}, {true, false}});
  expect(reverse.ok && reverse.win32Code == 0 && reverse.constraint.empty(),
         "SYSTEM + current user passes in reverse order");

  const auto systemToken = evaluate({true, 2, true, true}, {{true, true}, {true, true}});
  expect(systemToken.ok && systemToken.win32Code == 0 && systemToken.constraint.empty(),
         "process user equal to SYSTEM satisfies both trustee flags");
}

void testUnexpectedAceCountRefusals() {
  const auto single = evaluate({true, 1, true, true}, {{true, true}});
  expect(!single.ok && single.win32Code == rea::kPrivateDaclAccessDenied &&
             single.constraint ==
                 "Private DACL contains unexpected trustees; ace_count=1 protected=1 token_user_equals_system=1",
         "single-ACE DACL reports observed ace_count=1 and token_user_equals_system=1 with ERROR_ACCESS_DENIED");

  const auto three = evaluate({true, 3, true, false}, {{true, false}, {false, true}, {false, false}});
  expect(!three.ok && three.win32Code == rea::kPrivateDaclAccessDenied &&
             three.constraint ==
                 "Private DACL contains unexpected trustees; ace_count=3 protected=1 token_user_equals_system=0",
         "three-ACE DACL reports observed ace_count=3 with ERROR_ACCESS_DENIED");

  const auto absent = evaluate({false, 0, false, false}, {});
  expect(!absent.ok && absent.win32Code == rea::kPrivateDaclAccessDenied &&
             absent.constraint ==
                 "Private DACL contains unexpected trustees; ace_count=absent protected=0 token_user_equals_system=0",
         "null DACL reports ace_count=absent with ERROR_ACCESS_DENIED");
}

void testUnrelatedPrincipalRefusal() {
  const auto unrelatedSecond = evaluate({true, 2, true, false}, {{true, false}, {false, false}});
  expect(!unrelatedSecond.ok && unrelatedSecond.win32Code == rea::kPrivateDaclAccessDenied &&
             unrelatedSecond.constraint ==
                 "Private DACL permits an unrelated principal; ace_count=2 protected=1 token_user_equals_system=0",
         "unrelated second principal reports observed readback with ERROR_ACCESS_DENIED");

  const auto unrelatedFirst = evaluate({true, 2, false, false}, {{false, false}, {false, true}});
  expect(!unrelatedFirst.ok && unrelatedFirst.win32Code == rea::kPrivateDaclAccessDenied &&
             unrelatedFirst.constraint ==
                 "Private DACL permits an unrelated principal; ace_count=2 protected=0 token_user_equals_system=0",
         "unrelated first principal stops immediately with ERROR_ACCESS_DENIED");
}

void testMissingExpectedTrusteeRefusal() {
  const auto duplicateUser = evaluate({true, 2, true, false}, {{true, false}, {true, false}});
  expect(!duplicateUser.ok && duplicateUser.win32Code == rea::kPrivateDaclAccessDenied &&
             duplicateUser.constraint ==
                 "Private DACL must allow only current user and SYSTEM; ace_count=2 protected=1 token_user_equals_system=0",
         "missing SYSTEM trustee reports observed readback with ERROR_ACCESS_DENIED");

  const auto duplicateSystem = evaluate({true, 2, true, false}, {{false, true}, {false, true}});
  expect(!duplicateSystem.ok && duplicateSystem.win32Code == rea::kPrivateDaclAccessDenied &&
             duplicateSystem.constraint ==
                 "Private DACL must allow only current user and SYSTEM; ace_count=2 protected=1 token_user_equals_system=0",
         "missing current-user trustee reports observed readback with ERROR_ACCESS_DENIED");
}

}  // namespace

int main() {
  testValidUserAndSystemPass();
  testUnexpectedAceCountRefusals();
  testUnrelatedPrincipalRefusal();
  testMissingExpectedTrusteeRefusal();
  if (failures != 0) {
    std::cerr << failures << " assertion(s) failed\n";
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
