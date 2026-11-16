import depthLimit from 'graphql-depth-limit';

export const graphqlConfig = {
  path: '/graphql',
  autoSchemaFile: true,
  sortSchema: true,
  introspection: true,
  playground: true,
  validationRules: [depthLimit(8)],
};
