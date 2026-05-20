import React, { createContext, useContext, useState, PropsWithChildren } from 'react';

export interface RequestFormData {
  categorySlug: string;
  categoryName: string;
  pickupName: string;
  pickupLocation: string;
  pickupNotes: string;
  alreadyPaid: boolean;
  readyForCollection: boolean;
  destinationRegionSlug: string;
  destinationArea: string;
  destinationAddress: string;
  contactPhone: string;
  deliveryNotes: string;
  liabilityAcknowledged: boolean;
}

const initialData: RequestFormData = {
  categorySlug: '',
  categoryName: '',
  pickupName: '',
  pickupLocation: '',
  pickupNotes: '',
  alreadyPaid: false,
  readyForCollection: false,
  destinationRegionSlug: '',
  destinationArea: '',
  destinationAddress: '',
  contactPhone: '',
  deliveryNotes: '',
  liabilityAcknowledged: false,
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
