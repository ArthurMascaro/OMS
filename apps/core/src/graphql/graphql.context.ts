import DataLoader from 'dataloader';

import { StockBalance } from '@oms/contracts';

import type { StockProjectionQuery } from '../stock-projection/stock-projection.contract';

export interface GraphqlContext {
  loaders: {
    stockBySku: DataLoader<string, StockBalance>;
  };
}

export function createGraphqlContext(
  stockProjection: Pick<StockProjectionQuery, 'getBalances'>,
): GraphqlContext {
  return {
    loaders: {
      stockBySku: new DataLoader<string, StockBalance>(async (skus) => {
        const balances = await stockProjection.getBalances(skus);
        const balancesBySku = new Map(
          balances.map((balance) => [balance.sku, balance]),
        );

        return skus.map((sku) => {
          const balance = balancesBySku.get(sku);
          if (!balance) {
            throw new Error(`Stock balance missing for SKU ${sku}`);
          }
          return balance;
        });
      }),
    },
  };
}
