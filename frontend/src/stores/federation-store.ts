import { create } from "zustand";

type FederationUiState = {
  selectedProviderId: string | null;
  setSelectedProviderId: (providerId: string | null) => void;
};

/** Transient navigation state only. Server data and confidential form values stay out of Zustand. */
export const useFederationStore = create<FederationUiState>((set) => ({
  selectedProviderId: null,
  setSelectedProviderId: (selectedProviderId) => set({ selectedProviderId }),
}));
