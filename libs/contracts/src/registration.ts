export enum Capability {
  INVOICE_ORDER = 'INVOICE_ORDER',
  CANCEL_ORDER = 'CANCEL_ORDER',
  SHIP_ORDER = 'SHIP_ORDER',
  RETURN_ORDER = 'RETURN_ORDER',
  UPDATE_STOCK = 'UPDATE_STOCK',
}

export interface PluginManifest {
  id: string;
  marketplace: string;
  capabilities: Capability[];
}
