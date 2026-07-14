import React, { createContext, useContext, useState, PropsWithChildren } from 'react';

export interface RequestFormData {
  categorySlug: string;
  categoryName: string;
  pickupName: string;
  pickupLocation: string;
  pickupPostcode: string;
  pickupLat: number | null;
  pickupLng: number | null;
  pickupNotes: string;
  alreadyPaid: boolean;
  readyForCollection: boolean;
  destinationRegionSlug: string;
  destinationArea: string;
  destinationAddress: string;
  destinationPostcode: string;
  destinationLat: number | null;
  destinationLng: number | null;
  contactPhone: string;
  deliveryNotes: string;
  liabilityAcknowledged: boolean;
  schedulingMode: 'asap' | 'by' | 'flexible';
  neededBy: string | null; // ISO, only when schedulingMode === 'by'
  caughtRunId: string | null; // set if the customer "catches" a specific run
}

const initialData: RequestFormData = {
  categorySlug: '',
  categoryName: '',
  pickupName: '',
  pickupLocation: '',
  pickupPostcode: '',
  pickupLat: null,
  pickupLng: null,
  pickupNotes: '',
  alreadyPaid: false,
  readyForCollection: false,
  destinationRegionSlug: '',
  destinationArea: '',
  destinationAddress: '',
  destinationPostcode: '',
  destinationLat: null,
  destinationLng: null,
  contactPhone: '',
  deliveryNotes: '',
  liabilityAcknowledged: false,
  schedulingMode: 'asap',
  neededBy: null,
  caughtRunId: null,
};

interface RequestContextType {
  formData: RequestFormData;
  update: (patch: Partial<RequestFormData>) => void;
  reset: () => void;
}

const RequestContext = createContext<RequestContextType | undefined>(undefined);

export function RequestProvider({ children }: PropsWithChildren) {
  const [formData, setFormData] = useState<RequestFormData>(initialData);

  function update(patch: Partial<RequestFormData>) {
    setFormData((prev) => ({ ...prev, ...patch }));
  }

  function reset() {
    setFormData(initialData);
  }

  return (
    <RequestContext.Provider value={{ formData, update, reset }}>
      {children}
    </RequestContext.Provider>
  );
}

export function useRequest() {
  const context = useContext(RequestContext);
  if (!context) throw new Error('useRequest must be used within RequestProvider');
  return context;
}
