import { create } from "zustand";

export type AdminSection = "settings" | "users" | "groups" | "roles" | "tokens" | "catalog" | "audit" | "backup";

type AdminStore = {
  section: AdminSection;
  setSection: (section: AdminSection) => void;
};

export const useAdminStore = create<AdminStore>((set) => ({
  section: "settings",
  setSection: (section) => set({ section }),
}));
