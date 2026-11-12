import { describe, expect, it } from "vitest";
import { formatNaira, nairaToKobo, proRataFee, stageFee } from "../src/lib/money";

describe("money", () => {
  it("parses naira typed by people", () => {
    expect(nairaToKobo("250,000")).toBe(25_000_000);
    expect(nairaToKobo("₦1,500.5")).toBe(150_050);
    expect(nairaToKobo(" 100 ")).toBe(10_000);
    expect(() => nairaToKobo("12.345")).toThrow();
    expect(() => nairaToKobo("abc")).toThrow();
    expect(() => nairaToKobo("-5")).toThrow();
  });

  it("formats kobo as naira", () => {
    expect(formatNaira(25_000_000)).toBe("₦250,000");
    expect(formatNaira(150_050)).toBe("₦1,500.50");
    expect(formatNaira(0)).toBe("₦0");
  });

  it("charges a straight 5% with no minimum or cap", () => {
    expect(stageFee(nairaToKobo(500))).toBe(nairaToKobo(25));
    expect(stageFee(nairaToKobo(15_000))).toBe(nairaToKobo(750));
    expect(stageFee(nairaToKobo(250_000))).toBe(nairaToKobo(12_500));
    expect(stageFee(nairaToKobo(5_000_000))).toBe(nairaToKobo(250_000));
    expect(stageFee(nairaToKobo(20_000_000))).toBe(nairaToKobo(1_000_000));
    expect(stageFee(nairaToKobo(1_000.01))).toBe(5_000); // ₦50.0005 rounds to ₦50
  });

  it("splits the fee by the share paid", () => {
    expect(proRataFee(3_750_00, 125_000_00, 250_000_00)).toBe(1_875_00);
    expect(proRataFee(3_750_00, 0, 250_000_00)).toBe(0);
  });
});
