/**
 * Turning what somebody typed into an identity.
 *
 * This is the only place a phone number becomes something the system
 * compares, so two spellings of one number reaching storage would be two
 * accounts for one person — and every one-per-person guard we have is written
 * against the account. Hence the breadth here: it is not about punctuation,
 * it is about never letting the same SIM look like two people.
 */
import { describe, expect, it } from "@jest/globals";
import {
  displayPhone,
  isValidPhone,
  normalizePhone,
} from "@/lib/phoneNumber";

const e164 = (input: string) => {
  const out = normalizePhone(input);
  return out.ok ? out.e164 : `REFUSED:${out.problem}`;
};

describe("the ways a Pakistani mobile gets written", () => {
  it("accepts the way people actually type it", () => {
    // Off a SIM packet, from a contacts list, dictated over a phone.
    for (const written of [
      "03001234567",
      "0300 1234567",
      "0300-1234567",
      "+923001234567",
      "+92 300 1234567",
      "+92-300-1234567",
      "0092 300 1234567",
      "3001234567",
      " 03001234567 ",
      "(0300) 123 4567",
    ]) {
      expect(e164(written)).toBe("+923001234567");
    }
  });

  it("gives back one canonical form, whatever went in", () => {
    // The property the whole feature rests on: one SIM, one string.
    const spellings = ["03001234567", "+92 300 1234567", "0092-300-1234567"];
    expect(new Set(spellings.map(e164)).size).toBe(1);
  });

  it("keeps a national form for showing a person", () => {
    const out = normalizePhone("+923001234567");
    expect(out.ok && out.national).toBe("03001234567");
    expect(displayPhone("+923001234567")).toBe("0300 1234567");
  });
});

describe("what it refuses, and why that is told apart", () => {
  it("refuses nothing at all", () => {
    expect(e164("")).toBe("REFUSED:EMPTY");
    expect(e164("   ")).toBe("REFUSED:EMPTY");
  });

  it("refuses something that is not a number", () => {
    expect(e164("not a phone")).toBe("REFUSED:NOT_A_NUMBER");
    expect(e164("0300-ABC-4567")).toBe("REFUSED:NOT_A_NUMBER");
  });

  it("tells a foreign number apart from a typo", () => {
    /*
     * Different problems, different moves. A UK number means use a different
     * one; eight digits means look at what you typed. Collapsing both into
     * "invalid" leaves somebody guessing at their own door.
     */
    expect(e164("+447911123456")).toBe("REFUSED:NOT_PAKISTANI");
    expect(e164("030012345")).toBe("REFUSED:NOT_A_NUMBER");
  });

  it("refuses a landline, because an OTP cannot reach it", () => {
    // 021 is Karachi. Letting it through creates an account that can never
    // be verified and never signed in to.
    expect(e164("02135678901")).toBe("REFUSED:NOT_MOBILE");
    expect(e164("+922135678901")).toBe("REFUSED:NOT_MOBILE");
  });

  it("does not mistake a local number beginning 92 for a country code", () => {
    /*
     * The trap in the parsing. "92..." is a country code only when it cannot
     * be a local number — otherwise 03092345678 would be mangled into
     * something else entirely, and silently, because the result is still ten
     * digits.
     */
    expect(e164("03092345678")).toBe("+923092345678");
  });

  it("refuses a number too long to be anybody's", () => {
    expect(e164("+9230012345678901")).toBe("REFUSED:NOT_PAKISTANI");
  });
});

describe("isValidPhone", () => {
  it("agrees with normalizePhone", () => {
    expect(isValidPhone("03001234567")).toBe(true);
    expect(isValidPhone("02135678901")).toBe(false);
    expect(isValidPhone(null)).toBe(false);
    expect(isValidPhone(undefined)).toBe(false);
  });
});
