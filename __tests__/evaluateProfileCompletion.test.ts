import { isProfileCompleteForBonus } from "@/lib/evaluateProfileCompletion";
import type { ProfileCompletableUser } from "@/lib/evaluateProfileCompletion";

// Karachi is tier A with a towns list, so evaluateLocation's requirement set is
// ["cityId","areaId","houseNo"] and no pin is demanded. Using it keeps these
// cases about the two identity fields this module ADDS, rather than re-testing
// the location rules that __tests__/evaluateLocation.test.ts already covers.
const complete: ProfileCompletableUser = {
  userName: "Ayesha",
  phone: "03001234567",
  structuredAddress: { cityId: "Karachi", areaId: "DHA", houseNo: "12-C" },
};

describe("isProfileCompleteForBonus", () => {
  it("is true when location is complete and both identity fields are set", () => {
    expect(isProfileCompleteForBonus(complete)).toBe(true);
  });

  it.each([
    ["userName", { ...complete, userName: undefined }],
    ["phone", { ...complete, phone: undefined }],
  ])("is false when %s is missing", (_field, user) => {
    expect(isProfileCompleteForBonus(user as ProfileCompletableUser)).toBe(
      false,
    );
  });

  it.each([
    ["userName", { ...complete, userName: "   " }],
    ["phone", { ...complete, phone: "   " }],
  ])("is false when %s is whitespace only", (_field, user) => {
    expect(isProfileCompleteForBonus(user as ProfileCompletableUser)).toBe(
      false,
    );
  });

  it("is false when the location half is incomplete", () => {
    const noHouseNo: ProfileCompletableUser = {
      ...complete,
      structuredAddress: { cityId: "Karachi", areaId: "DHA" },
    };

    expect(isProfileCompleteForBonus(noHouseNo)).toBe(false);
  });

  it("is false for null and undefined", () => {
    expect(isProfileCompleteForBonus(null)).toBe(false);
    expect(isProfileCompleteForBonus(undefined)).toBe(false);
  });

  /**
   * The reason this module exists rather than reusing update-profile's
   * `phone && address` referral predicate. That predicate would pay this user;
   * the app would still be showing them "Finish your profile", because there is
   * no house number and no pin. If this ever starts returning true, the bonus
   * has drifted looser than the gate the user actually sees.
   */
  it("is stricter than the `phone && address` predicate referrals pay on", () => {
    const passesReferralPredicate = {
      userName: "Ayesha",
      phone: "03001234567",
      // A free-text street and nothing structured — `address` is not read by
      // evaluateLocation at all.
      city: "Karachi",
    } as ProfileCompletableUser;

    expect(isProfileCompleteForBonus(passesReferralPredicate)).toBe(false);
  });
});
