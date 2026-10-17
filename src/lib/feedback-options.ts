/**
 * What a tester can choose when sending feedback, and how long a message may
 * be. Kept apart from src/lib/feedback.ts, which talks to the database, so the
 * browser can import these for the form and for the admin's list.
 */

export const FEEDBACK_CATEGORIES = ["playback", "broken", "idea", "other"] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  playback: "Playback problem",
  broken: "Something's broken",
  idea: "Idea",
  other: "Other",
};

/** The most characters a message keeps, counted after the spaces at its ends are trimmed. */
export const FEEDBACK_MESSAGE_MAX = 1000;
