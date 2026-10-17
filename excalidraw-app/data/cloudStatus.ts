import { atom } from "../app-jotai";

export const cloudSaveStateAtom = atom<"idle" | "saving" | "saved" | "error">(
  "idle",
);

export const cloudPendingUploadsAtom = atom(0);
export const cloudFileErrorAtom = atom(false);
