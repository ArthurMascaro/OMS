import { INestApplication } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { GraphQLSchema, isObjectType } from 'graphql';

import { AppModule } from '../app.module';

describe('GraphQL schema', () => {
  let app: INestApplication;
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    schema = app.get(GraphQLSchemaHost).schema;
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not expose mutations', () => {
    expect(schema.getMutationType()).toBeUndefined();
  });

  it('exposes order queries', () => {
    const queryFields = schema.getQueryType()?.getFields();

    expect(queryFields).toHaveProperty('order');
    expect(queryFields).toHaveProperty('orders');
  });

  it('exposes stock queries and the order stock field', () => {
    const queryFields = schema.getQueryType()?.getFields();
    const orderType = schema.getType('Order');
    const orderFields = isObjectType(orderType)
      ? orderType.getFields()
      : undefined;

    expect(queryFields).toHaveProperty('stock');
    expect(queryFields).toHaveProperty('movements');
    expect(orderFields).toHaveProperty('stock');
  });
});
