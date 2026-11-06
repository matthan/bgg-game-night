import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faDiceFive,
  faDiceFour,
  faDiceOne,
  faDiceSix,
  faDiceThree,
  faDiceTwo,
  faSquare,
} from "@fortawesome/free-solid-svg-icons";
import type { InterestLevel } from "./types";

/**
 * The interest levels, keenest first. The number is what the API stores;
 * "no opinion" is simply having no level. Each level is shown as a Font
 * Awesome die (six pips = keenest, one pip = rather not), in its color,
 * drawn with white pips by <Die> (components/Die.tsx).
 */
export const INTEREST_LEVELS: { level: InterestLevel; label: string; icon: IconDefinition; color: string }[] = [
  { level: 5, label: "Yes, please!", icon: faDiceSix, color: "#2f9e44" },
  { level: 4, label: "Sounds great", icon: faDiceFive, color: "#74b816" },
  { level: 3, label: "Sure thing", icon: faDiceFour, color: "#a9c23a" },
  { level: 2, label: "Slightly", icon: faDiceThree, color: "#fcc419" }, // yellow: between orange and lime
  { level: 1, label: "Not particularly", icon: faDiceTwo, color: "#f08c00" },
  { level: 0, label: "Rather not", icon: faDiceOne, color: "#e03131" },
];

/** No level set: a plain black square (Font Awesome fa-square). */
export const NO_OPINION = { label: "No opinion", icon: faSquare, color: "#000" };

/** Accounts left out of the interest display (e.g. the shared guest login). */
export const HIDDEN_FROM_INTEREST = ["guest"];
export const showInInterest = (username: string) => !HIDDEN_FROM_INTEREST.includes(username.toLowerCase());

export const interestInfo = (level: InterestLevel) => INTEREST_LEVELS.find((l) => l.level === level)!;
