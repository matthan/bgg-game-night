import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faDiceFive, faDiceOne, faDiceSix, faDiceThree, faSquare } from "@fortawesome/free-solid-svg-icons";
import type { InterestLevel } from "./types";

/**
 * The interest levels, keenest first. The number is what the API stores;
 * "no opinion" is simply having no level. Each level is shown as a Font
 * Awesome die (more pips = keener; a blank die = no thanks), in its color.
 */
export const INTEREST_LEVELS: { level: InterestLevel; label: string; icon: IconDefinition; color: string }[] = [
  { level: 2, label: "Yes, please!", icon: faDiceSix, color: "#2f9e44" },
  { level: 1, label: "Sounds good", icon: faDiceFive, color: "#74b816" },
  { level: 0, label: "Take it or leave it", icon: faDiceThree, color: "#868e96" },
  { level: -1, label: "Rather not", icon: faDiceOne, color: "#f08c00" },
  { level: -2, label: "No thanks", icon: faSquare, color: "#e03131" }, // blank die
];

export const NO_OPINION = { label: "No opinion", symbol: "—" };

/** Accounts left out of the interest display (e.g. the shared guest login). */
export const HIDDEN_FROM_INTEREST = ["guest"];
export const showInInterest = (username: string) => !HIDDEN_FROM_INTEREST.includes(username.toLowerCase());

export const interestInfo = (level: InterestLevel) => INTEREST_LEVELS.find((l) => l.level === level)!;
