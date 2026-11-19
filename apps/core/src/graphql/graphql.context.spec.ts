import { StockBalance } from '@oms/contracts';

import { createGraphqlContext } from './graphql.context';

describe('GraphQL stock DataLoader', () => {
  it('loads multiple SKUs with one stock read', async () => {
    const balances: StockBalance[] = [
      { sku: 'SKU-1', physical: 10, reserved: 2, available: 8 },
      { sku: 'SKU-2', physical: 5, reserved: 1, available: 4 },
    ];
    const getBalances = jest.fn().mockResolvedValue(balances);
    const context = createGraphqlContext({ getBalances });

    const results = await Promise.all([
      context.loaders.stockBySku.load('SKU-1'),
      context.loaders.stockBySku.load('SKU-2'),
    ]);

    expect(results).toEqual(balances);
    expect(getBalances).toHaveBeenCalledTimes(1);
    expect(getBalances).toHaveBeenCalledWith(['SKU-1', 'SKU-2']);
  });
});
