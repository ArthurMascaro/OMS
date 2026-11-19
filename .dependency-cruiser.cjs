module.exports = {
  forbidden: [
    {
      name: 'graphql-must-not-access-database',
      severity: 'error',
      comment:
        'GraphQL resolvers must use application services instead of database adapters.',
      from: {
        path: '^apps/core/src/graphql',
      },
      to: {
        path: '^apps/core/src/database',
      },
    },
  ],
};
