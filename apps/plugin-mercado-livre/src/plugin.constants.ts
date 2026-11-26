import { PLUGIN_QUEUE_PREFIX } from '@oms/contracts';

export const PLUGIN_ID = 'mercado-livre';
export const PLUGIN_QUEUE = `${PLUGIN_QUEUE_PREFIX}${PLUGIN_ID}`;
export const PLUGIN_DLQ = `${PLUGIN_QUEUE}.dlq`;
